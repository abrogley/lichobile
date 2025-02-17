import * as debounce from 'lodash/debounce'
import router from '../../router'
import Chessground from '../../chessground/Chessground'
import * as cg from '../../chessground/interfaces'
import * as chess from '../../chess'
import * as chessFormat from '../../utils/chessFormat'
import { build as makeTree, path as treePath, ops as treeOps, TreeWrapper, Tree } from '../shared/tree'
import redraw from '../../utils/redraw'
import session from '../../session'
import vibrate from '../../vibrate'
import sound from '../../sound'
import { toggleGameBookmark } from '../../xhr'
import socket, { SocketIFace } from '../../socket'
import { openingSensibleVariants } from '../../lichess/variant'
import { playerName as gamePlayerName } from '../../lichess/player'
import * as gameApi from '../../lichess/game'
import { AnalyseData, AnalyseDataWithTree, isOnlineAnalyseData } from '../../lichess/interfaces/analyse'
import { Study, findTag } from '../../lichess/interfaces/study'
import { Opening } from '../../lichess/interfaces/game'
import settings from '../../settings'
import { handleXhrError, oppositeColor, hasNetwork, noop } from '../../utils'
import promotion from '../shared/offlineRound/promotion'
import continuePopup, { Controller as ContinuePopupController } from '../shared/continuePopup'
import { NotesCtrl } from '../shared/round/notes'

import * as util from './util'
import CevalCtrl from './ceval/CevalCtrl'
import RetroCtrl, { IRetroCtrl } from './retrospect/RetroCtrl'
import { ICevalCtrl } from './ceval/interfaces'
import crazyValid from './crazy/crazyValid'
import ExplorerCtrl from './explorer/ExplorerCtrl'
import { IExplorerCtrl } from './explorer/interfaces'
import analyseMenu, { IMainMenuCtrl } from './menu'
import analyseSettings, { ISettingsCtrl } from './analyseSettings'
import ground from './ground'
import socketHandler from './analyseSocketHandler'
import { make as makeEvalCache, EvalCache } from './evalCache'
import { Source } from './interfaces'
import * as tabs from './tabs'
import StudyCtrl from './study/StudyCtrl'

export default class AnalyseCtrl {

  settings: ISettingsCtrl
  menu: IMainMenuCtrl
  continuePopup: ContinuePopupController
  notes: NotesCtrl | null
  chessground!: Chessground
  ceval: ICevalCtrl
  retro: IRetroCtrl | null
  explorer: IExplorerCtrl
  tree: TreeWrapper
  evalCache: EvalCache
  study?: StudyCtrl

  socketIface: SocketIFace

  // current tree state, cursor, and denormalized node lists
  path!: Tree.Path
  node!: Tree.Node
  nodeList!: Tree.Node[]
  mainline!: Tree.Node[]

  // state flags
  onMainline: boolean = true
  synthetic: boolean // false if coming from a real game
  ongoing: boolean // true if real game is ongoing

  // paths
  initialPath: Tree.Path
  gamePath?: Tree.Path
  contextMenu: Tree.Path | null = null

  // various view state flags
  replaying: boolean = false
  cgConfig?: cg.SetConfig
  analysisProgress: boolean = false
  retroGlowing: boolean = false
  formattedDate: string

  private _currentTabIndex: number = 0

  private debouncedExplorerSetStep: () => void

  constructor(
    readonly data: AnalyseData,
    studyData: Study | undefined,
    readonly source: Source,
    readonly orientation: Color,
    readonly shouldGoBack: boolean,
    ply?: number,
    tabId?: string
  ) {
    this.synthetic = util.isSynthetic(data)
    this.ongoing = !this.synthetic && gameApi.playable(data)
    this.initialPath = treePath.root

    this.study = studyData !== undefined ? new StudyCtrl(studyData, this) : undefined

    this._currentTabIndex = (!this.study || this.study.data.chapter.tags.length === 0) && this.synthetic ? 0 : 1

    if (settings.analyse.supportedVariants.indexOf(this.data.game.variant.key) === -1) {
      window.plugins.toast.show(`Analysis board does not support ${this.data.game.variant.name} variant.`, 'short', 'center')
      router.set('/')
    }

    this.tree = makeTree(treeOps.reconstruct(this.data.treeParts))

    this.settings = analyseSettings.controller(this)
    this.menu = analyseMenu.controller(this)
    this.continuePopup = continuePopup.controller()

    this.notes = session.isConnected() && this.data.game.speed === 'correspondence' ? new NotesCtrl(this.data) : null

    this.retro = null

    this.ceval = CevalCtrl(
      this.data.game.variant.key,
      this.isCevalAllowed(),
      this.onCevalMsg,
      {
        multiPv: this.settings.s.cevalMultiPvs,
        cores: this.settings.s.cevalCores,
        infinite: this.settings.s.cevalInfinite
      }
    )

    const explorerAllowed = !this.study || this.study.data.chapter.features.explorer
    this.explorer = ExplorerCtrl(this, explorerAllowed)
    this.debouncedExplorerSetStep = debounce(this.explorer.setStep, this.data.pref.animationDuration + 50)

    const initPly = ply !== undefined ? ply : this.tree.lastPly()

    this.gamePath = (this.synthetic || this.ongoing) ? undefined :
      treePath.fromNodeList(treeOps.mainlineNodeList(this.tree.root))

    const mainline = treeOps.mainlineNodeList(this.tree.root)
    this.initialPath = treeOps.takePathWhile(mainline, n => n.ply <= initPly)
    this.setPath(this.initialPath)

    const gameMoment = window.moment(this.data.game.createdAt)

    this.formattedDate = gameMoment.format('L LT')

    if (this.study) {
      this.socketIface = this.study.createSocket()
    } else if (
      !this.data.analysis &&
      session.isConnected() &&
      isOnlineAnalyseData(this.data) &&
      gameApi.analysable(this.data) &&
      this.data.url !== undefined &&
      this.data.player.version !== undefined
    ) {
      this.socketIface = socket.createGame(
        this.data.url.socket,
        this.data.player.version,
        socketHandler(this),
        this.data.url.round
      )
    } else {
      this.socketIface = socket.createAnalysis(socketHandler(this))
    }

    this.evalCache = makeEvalCache({
      variant: this.data.game.variant.key,
      canGet: this.canEvalGet,
      getNode: () => this.node,
      receive: this.onCevalMsg,
      socketIface: this.socketIface,
    })

    this.updateBoard()

    if (tabId) {
      const curTabIndex = this.currentTabIndex(this.availableTabs())
      const newTabIndex = this.availableTabs().map((tab: tabs.Tab) => tab.id === tabId).reduce((acc: number, match: boolean, index: number) => match ? index : acc, curTabIndex)
      if (newTabIndex) {
        this.onTabChange(newTabIndex)
      }
    }

    if (this.currentTab(this.availableTabs()).id === 'explorer') {
      this.debouncedExplorerSetStep()
    }

    setTimeout(this.debouncedScroll, 250)
    setTimeout(this.initCeval, 1000)
  }

  canDrop = () => {
    return true
  }

  player = () => {
    return this.data.game.player
  }

  playerName(color: Color): string {
    const p = gameApi.getPlayer(this.data, color)
    return this.study ? findTag(this.study.data, color) || 'Anonymous' : gamePlayerName(p)
  }

  topColor(): Color {
    return oppositeColor(this.bottomColor())
  }

  bottomColor(): Color {
    return this.settings.s.flip ? oppositeColor(this.data.orientation) : this.data.orientation
  }

  availableTabs = (): ReadonlyArray<tabs.Tab> => {
    let val: ReadonlyArray<tabs.Tab> = [tabs.moves]

    if (this.study && this.study.data.chapter.tags.length > 0) val = [tabs.pgnTags, ...val]
    if (!this.synthetic) val = [tabs.gameInfos, ...val]
    // TODO enable only when study.canContribute() is false with write support
    if (this.study) val = [...val, tabs.comments]
    if (!this.retro && this.ceval.enabled()) val = [...val, tabs.ceval]
    if (this.study || (isOnlineAnalyseData(this.data) && gameApi.analysable(this.data))) {
      val = [...val, tabs.charts]
    }
    if (hasNetwork() && this.explorer.allowed) val = [...val, tabs.explorer]

    return val
  }

  currentTabIndex = (avail: ReadonlyArray<tabs.Tab>): number => {
    if (this._currentTabIndex > avail.length - 1) return avail.length - 1
    else return this._currentTabIndex
  }

  currentTab = (avail: ReadonlyArray<tabs.Tab>): tabs.Tab => {
    return avail[this.currentTabIndex(avail)]
  }

  onTabChange = (index: number) => {
    this._currentTabIndex = index
    const cur = this.currentTab(this.availableTabs())
    this.updateHref()
    if (cur.id === 'moves') this.debouncedScroll()
    else if (cur.id === 'explorer') this.explorer.setStep()
    redraw()
  }

  // call this when removing a tab, to avoid a lazy tab loading indefinitely
  resetTabs = () => this.onTabChange(this.currentTabIndex(this.availableTabs()))

  setPath = (path: Tree.Path): void => {
    this.path = path
    this.nodeList = this.tree.getNodeList(path)
    this.node = treeOps.last(this.nodeList) as Tree.Node
    this.mainline = treeOps.mainlineNodeList(this.tree.root)
    this.onMainline = this.tree.pathIsMainline(path)
  }

  promote(path: Tree.Path, toMainline: boolean): void {
    this.tree.promoteAt(path, toMainline)
    this.contextMenu = null
    this.jump(path)
  }

  deleteNode(path: Tree.Path): void {
    const node = this.tree.nodeAtPath(path)
    if (!node) return
    const count = treeOps.countChildrenAndComments(node)
    if (count.nodes >= 10 || count.comments > 0) {
      navigator.notification.confirm(
        `Delete ${count.nodes} move(s)` + (count.comments ? ` and ${count.comments} comment(s)` : '') + '?',
        () => this._deleteNode(path)
      )
    } else {
      this._deleteNode(path)
    }
  }

  initCeval = () => {
    if (this.ceval.enabled()) {
      if (this.ceval.isInit()) {
        this.debouncedStartCeval()
      } else {
        this.ceval.init().then(this.debouncedStartCeval)
      }
    }
  }

  startCeval = () => {
    if (this.ceval.enabled() && this.canUseCeval()) {
      this.ceval.start(this.path, this.nodeList, !!this.retro)
      this.evalCache.fetch(this.path, this.ceval.getMultiPv())
    }
  }

  stopCevalImmediately = () => {
    this.ceval.stop()
    this.debouncedStartCeval.cancel()
  }

  toggleRetro = (fromBB?: string): void => {
    if (this.retro) {
      if (fromBB !== 'backbutton') router.backbutton.stack.pop()
      this.retro = null
      // retro toggle ceval only if not enabled
      // we use stored settings to see if it was previously enabled or not
      if (settings.analyse.enableCeval()) {
        this.startCeval()
      }
      // ceval not enabled if no moves were to review
      else if (this.ceval.enabled()) {
        this.ceval.toggle()
      }
    }
    else {
      this.stopCevalImmediately()
      this.retro = RetroCtrl(this)
      router.backbutton.stack.push(this.toggleRetro)
      this.retro.jumpToNext()
    }
  }

  debouncedScroll = debounce(() => util.autoScroll(document.getElementById('replay')), 200)

  jump = (path: Tree.Path, direction?: 'forward' | 'backward') => {
    const pathChanged = path !== this.path
    this.setPath(path)
    this.updateBoard()
    this.fetchOpening()
    if (this.node && this.node.san && direction === 'forward') {
      if (this.node.san.indexOf('x') !== -1) sound.throttledCapture()
      else sound.throttledMove()
    }
    this.ceval.stop()
    this.debouncedExplorerSetStep()
    this.updateHref()
    promotion.cancel(this.chessground, this.cgConfig)
    if (pathChanged) {
      if (this.retro) this.retro.onJump()
      else {
        this.debouncedStartCeval()
      }
    }
  }

  userJump = (path: Tree.Path, direction?: 'forward' | 'backward') => {
    this.jump(path, direction)
  }

  jumpToMain = (ply: number) => {
    this.userJump(this.mainlinePathToPly(ply))
  }

  jumpToIndex = (index: number) => {
    this.jumpToMain(index + 1 + (this.data.game.startedAtTurn || 0))
  }

  fastforward = () => {
    this.replaying = true
    const more = this.next()
    if (!more) {
      this.replaying = false
      this.debouncedScroll()
    }
    return more
  }

  stopff = () => {
    this.replaying = false
    this.next()
    this.debouncedScroll()
  }

  rewind = () => {
    this.replaying = true
    const more = this.prev()
    if (!more) {
      this.replaying = false
      this.debouncedScroll()
    }
    return more
  }

  stoprewind = () => {
    this.replaying = false
    this.prev()
    this.debouncedScroll()
  }

  toggleBookmark = () => {
    return toggleGameBookmark(this.data.game.id).then(() => {
      this.data.bookmarked = !this.data.bookmarked
      redraw()
    })
    .catch(handleXhrError)
  }

  uciMove = (uci: string) => {
    const move = chessFormat.decomposeUci(uci)
    if (uci[1] === '@') {
      this.chessground.apiNewPiece({
        color: this.chessground.state.movable.color as Color,
        role: chessFormat.sanToRole[uci[0]]
      }, move[1])
    } else if (!move[2]) {
      this.sendMove(move[0], move[1])
    }
    else {
      this.sendMove(move[0], move[1], chessFormat.sanToRole[move[2].toUpperCase()])
    }
    this.explorer.loading(true)
  }

  mergeAnalysisData(data: AnalyseDataWithTree): void {
    if (!this.analysisProgress) {
      this.analysisProgress = true
      redraw()
    }
    this.tree.merge(data.tree)
    this.data.analysis = data.analysis
    const anaMainline = treeOps.mainlineNodeList(data.tree)
    const analysisComplete = anaMainline.every(n =>
      n.eval !== undefined || !!(n.san && n.san.includes('#'))
    )
    if (analysisComplete) {
      this.data.treeParts = anaMainline
      this.analysisProgress = false
      this.retroGlowing = true
      setTimeout(() => {
        this.retroGlowing = false
        redraw()
      }, 1000 * 8)
      sound.dong()
      vibrate.quick()
      redraw()
    }
    if (this.retro) this.retro.onMergeAnalysisData()
    redraw()
  }

  gameOver(): boolean {
    if (!this.node) return false
    // node.end boolean is fetched async for online games (along with the dests)
    if (this.node.end === undefined) {
      if (this.node.check) {
        const san = this.node.san
        const checkmate = !!(san && san[san.length - 1] === '#')
        return checkmate
      }
    } else {
      return this.node.end
    }

    return false
  }

  canUseCeval = () => {
    return !this.gameOver()
  }

  nextNodeBest() {
    return treeOps.withMainlineChild(this.node, (n: Tree.Node) => n.eval ? n.eval.best : undefined)
  }

  mainlinePathToPly(ply: Ply): Tree.Path {
    return treeOps.takePathWhile(this.mainline, n => n.ply <= ply)
  }

  hasAnyComputerAnalysis = () => {
    return this.data.analysis || this.ceval.enabled()
  }

  hasFullComputerAnalysis = (): boolean => {
    return Object.keys(this.mainline[0].eval || {}).length > 0
  }

  isOfflineOrNotPlayable = (): boolean => {
    return this.source === 'offline' || !gameApi.playable(this.data)
  }

  unload = () => {
    if (this.ceval) this.ceval.destroy()
  }

  // ---

  private _deleteNode = (path: Tree.Path) => {
    this.tree.deleteNodeAt(path)
    this.contextMenu = null
    if (treePath.contains(this.path, path)) this.userJump(treePath.init(path))
    else this.jump(this.path)
  }

  private updateHref = debounce(() => {
    router.setQueryParams({
      tabId: this.currentTab(this.availableTabs()).id,
      ply: String(this.node.ply),
      curFen: this.node.fen
    })
  }, 200)

  private canGoForward() {
    return this.node.children.length > 0
  }

  private next() {
    if (!this.canGoForward()) return false

    const child = this.node.children[0]
    if (child) this.userJump(this.path + child.id, 'forward')

    return true
  }

  private prev() {
    this.userJump(treePath.init(this.path), 'backward')

    return true
  }

  private canEvalGet = (node: Tree.Node): boolean => node.ply < 15

  private sendMove = (orig: Key, dest: Key, prom?: Role) => {
    const move: chess.MoveRequest = {
      orig,
      dest,
      variant: this.data.game.variant.key,
      fen: this.node.fen,
      path: this.path
    }
    if (prom) move.promotion = prom
    chess.move(move)
    .then(this.addNode)
    .catch(err => console.error('send move error', move, err))
  }

  private userMove = (orig: Key, dest: Key, captured?: Piece) => {
    if (captured) sound.capture()
    else sound.move()
    if (!promotion.start(this.chessground, orig, dest, this.sendMove)) this.sendMove(orig, dest)
  }

  private userNewPiece = (piece: Piece, pos: Key) => {
    if (crazyValid.drop(piece.role, pos, this.node.drops)) {
      sound.move()
      const drop = {
        role: piece.role,
        pos,
        variant: this.data.game.variant.key,
        fen: this.node.fen,
        path: this.path
      }
      chess.drop(drop)
      .then(this.addNode)
      .catch(err => {
        // catching false drops here
        console.error('wrong drop', err)
        this.jump(this.path)
      })
    } else this.jump(this.path)
  }

  private addNode = ({ situation, path }: chess.MoveResponse) => {
    const curNode = this.node
    const node = {
      id: situation.id,
      ply: situation.ply,
      fen: situation.fen,
      children: [],
      dests: situation.dests,
      drops: situation.drops,
      check: situation.check,
      end: situation.end,
      player: situation.player,
      checkCount: situation.checkCount,
      uci: situation.uci,
      san: situation.san,
      crazyhouse: situation.crazyhouse,
      pgnMoves: curNode && curNode.pgnMoves ? curNode.pgnMoves.concat(situation.pgnMoves) : situation.pgnMoves
    }
    if (path === undefined) {
      console.error('Cannot addNode, missing path', node)
      return
    }
    const newPath = this.tree.addNode(node, path)
    if (!newPath) {
      console.error('Cannot addNode', node, path)
      return
    }
    this.jump(newPath)
    this.debouncedScroll()
    redraw()
  }

  private isCevalAllowed(): boolean {
    const study = this.study && this.study.data

    if (!gameApi.analysableVariants.includes(this.data.game.variant.key)) {
      return false
    }

    if (study && !(study.chapter.features.computer || study.chapter.practice)) {
      return false
    }

    return this.isOfflineOrNotPlayable()
  }

  private onCevalMsg = (path: string, ceval?: Tree.ClientEval) => {
    if (ceval) {
      this.tree.updateAt(path, (node: Tree.Node) => {
        if (node.ceval && node.ceval.depth >= ceval.depth) return

        if (node.ceval === undefined) {
          node.ceval = { ...ceval }
        }
        else {
          node.ceval = { ...node.ceval, ...ceval }
          // hitting a cloud eval after a local eval, we don't want maxDepth,
          // knps and millis
          if (ceval.cloud) {
            node.ceval.maxDepth = undefined
            node.ceval.knps = undefined
            node.ceval.millis = undefined
          }
          // hitting a local eval after cloud, let's, just remove cloud flag
          else {
            node.ceval.cloud = false
          }
        }

        if (node.ceval.pvs.length > 0) {
          node.ceval.best = node.ceval.pvs[0].moves[0]
        }

        if (path === this.path) {
          if (this.retro) this.retro.onCeval()
          if (ceval.cloud && ceval.depth >= this.ceval.effectiveMaxDepth()) {
            this.ceval.stop()
          }
          redraw()
        }
      })
    }
    // no ceval means stockfish has finished, just redraw
    else {
      if (this.currentTab(this.availableTabs()).id === 'ceval') redraw()
    }
  }

  private debouncedStartCeval = debounce(this.startCeval, 800)

  private updateBoard() {
    const node = this.node

    if (this.data.game.variant.key === 'threeCheck' && !node.checkCount) {
      node.checkCount = util.readCheckCount(node.fen)
    }

    const color: Color = node.ply % 2 === 0 ? 'white' : 'black'
    const dests = chessFormat.readDests(node.dests)
    const config = {
      fen: node.fen,
      turnColor: color,
      orientation: this.settings.s.flip ? oppositeColor(this.orientation) : this.orientation,
      movableColor: this.gameOver() ? null : color,
      dests: dests || null,
      check: !!node.check,
      lastMove: node.uci ? chessFormat.uciToMoveOrDrop(node.uci) : null
    }

    this.cgConfig = config
    this.data.game.player = color
    if (!this.chessground) {
      this.chessground = ground.make(this.data, config, this.orientation, this.userMove, this.userNewPiece)
    } else {
      this.chessground.set(config)
    }

    if (!dests) this.getNodeSituation()
  }

  private getNodeSituation = debounce(() => {
    if (this.node && !this.node.dests) {
      chess.situation({
        variant: this.data.game.variant.key,
        fen: this.node.fen,
        path: this.path
      })
      .then(({ situation, path }) => {
        this.tree.updateAt(path, (node: Tree.Node) => {
          node.dests = situation.dests
          node.end = situation.end
          node.player = situation.player
        })
        if (path === this.path) {
          this.updateBoard()
          redraw()
          if (this.gameOver()) this.stopCevalImmediately()
        }
      })
      .catch(err => console.error('get dests error', err))
    }
  }, 50)

  private fetchOpening = debounce(() => {
    if (
      hasNetwork() && this.node && this.node.opening === undefined &&
      this.node.ply <= 20 && this.node.ply > 0 &&
      openingSensibleVariants.has(this.data.game.variant.key)
    ) {
      let msg: { fen: string, path: string, variant?: VariantKey } = {
        fen: this.node.fen,
        path: this.path
      }
      const variant = this.data.game.variant.key
      if (variant !== 'standard') msg.variant = variant
      this.tree.updateAt(this.path, (node: Tree.Node) => {
        // flag opening as null in any case to not request twice
        node.opening = null
        this.socketIface.ask('opening', 'opening', msg)
        .then((d: { opening: Opening, path: string }) => {
          if (d.opening && d.path) {
            node.opening = d.opening
            if (d.path === this.path) redraw()
          }
        })
        .catch(noop)
      })
    }
  }, 50)
}
