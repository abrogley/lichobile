import { batchRequestAnimationFrame } from '../utils/batchRAF'
import * as cg from './interfaces'
import * as util from './util'
import * as board from './board'
import { State } from './state'
import { initBoard, configureBoard, setNewBoardState } from './configure'
import fen from './fen'
import { renderBoard, makeCoords, makeSymmCoords } from './render'
import { anim, skip as skipAnim } from './anim'
import * as drag from './drag'

const pieceScores: {[id: string]: number} = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: 0
}

export default class Chessground {
  public state: State
  public dom?: cg.DOM

  private resizeTimeoutId: number = 0

  constructor(cfg: cg.InitConfig) {
    this.state = initBoard(cfg)
  }

  attach(wrapper: HTMLElement) {
    const isViewOnly = this.state.fixed || this.state.viewOnly
    const board = document.createElement('div')
    board.className = 'cg-board'
    if (isViewOnly) board.className += ' view-only'
    else board.className += ' manipulable'

    wrapper.appendChild(board)

    this.dom = {
      board,
      elements: {},
      bounds: this.state.fixed ? {
        // dummy bounds since fixed board doesn't use bounds
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        height: 0,
        width: 0
      } : wrapper.getBoundingClientRect()
    }

    this.redrawSync()

    if (!isViewOnly) {
      const shadow = document.createElement('div')
      shadow.className = 'cg-square-target'
      shadow.style.transform = util.translate3dAway
      wrapper.appendChild(shadow)
      this.dom.elements.shadow = shadow
    }

    if (!isViewOnly && this.state.draggable.showGhost) {
      const ghost = document.createElement('piece')
      ghost.className = 'ghost'
      ghost.style.transform = util.translateAway
      wrapper.appendChild(ghost)
      this.dom.elements.ghost = ghost
    }

    if (this.state.coordinates) {
      makeCoords((wrapper), !!this.state.symmetricCoordinates)
      if (this.state.symmetricCoordinates) {
        makeSymmCoords(wrapper)
      }
    }

    if (!isViewOnly) {
      board.addEventListener('touchstart', (e: TouchEvent) => drag.start(this, e))
      board.addEventListener('touchmove', (e: TouchEvent) => drag.move(this, e))
      board.addEventListener('touchend', (e: TouchEvent) => drag.end(this, e))
      board.addEventListener('touchcancel', () => drag.cancel(this))
    }

    window.addEventListener('resize', this.onOrientationChange)
  }

  detach = () => {
    this.dom = undefined
    window.removeEventListener('resize', this.onOrientationChange)
  }

  setBounds = (bounds: ClientRect) => {
    if (this.dom) this.dom.bounds = bounds
  }

  applyAnim = (now: number): void => {
    const state = this.state
    const cur = state.animation.current
    // animation was cancelled
    if (cur === null) {
      this.redrawSync()
      return
    }
    if (cur.start === null) cur.start = now
    const rest = 1 - (now - cur.start) / cur.duration
    if (rest <= 0) {
      state.animation.current = null
      this.redrawSync()
    } else {
      const ease = util.easeInOutCubic(rest)
      const anims = cur.plan.anims
      const animsK = Object.keys(anims)
      for (let i = 0, len = animsK.length; i < len; i++) {
        const key = animsK[i]
        const cfg = anims[key]
        cfg[1] = [util.roundBy(cfg[0][0] * ease, 10), util.roundBy(cfg[0][1] * ease, 10)]
      }
      this.redrawSync()
      batchRequestAnimationFrame(this.applyAnim)
    }
  }

  redrawSync = (): void => {
    if (this.dom) renderBoard(this.state, this.dom)
  }

  redraw = (): void => {
    batchRequestAnimationFrame(this.redrawSync)
  }

  getFen = (): string => {
    return fen.write(this.state.pieces)
  }

  getMaterialDiff(): cg.MaterialDiff {
    let score = 0
    const counts: { [role: string]: number } = {
      king: 0,
      queen: 0,
      rook: 0,
      bishop: 0,
      knight: 0,
      pawn: 0
    }
    const piecesKeys = Object.keys(this.state.pieces)
    for (let i = 0; i < piecesKeys.length; i++) {
      const p = this.state.pieces[piecesKeys[i]]
      counts[p.role] += (p.color === 'white') ? 1 : -1
      score += pieceScores[p.role] * (p.color === 'white' ? 1 : -1)
    }
    const diff: cg.MaterialDiff = {
      white: {pieces: {}, score: score},
      black: {pieces: {}, score: -score}
    }
    for (let role in counts) {
      const c = counts[role]
      if (c > 0) diff.white.pieces[role] = c
      else if (c < 0) diff.black.pieces[role] = -c
    }
    return diff
  }

  set(config: cg.SetConfig): void {
    anim(state => setNewBoardState(state, config), this)
  }

  reconfigure(config: cg.InitConfig): void {
    anim(state => configureBoard(state, config), this)
  }

  toggleOrientation = (): void => {
    anim(board.toggleOrientation, this)
  }

  setOtbMode(mode: 'flip' | 'facing'): void {
    anim(state => {
      state.otbMode = mode
    }, this)
  }

  setPieces(pieces: cg.PiecesDiff): void {
    anim(state => board.setPieces(state, pieces), this)
  }

  dragNewPiece(e: TouchEvent, piece: Piece, force = false): void {
    drag.dragNewPiece(this, piece, e, force)
  }

  selectSquare(key: Key | null): void {
    if (key) anim(state => board.selectSquare(state, key), this)
    else if (this.state.selected) {
      board.unselect(this.state)
      this.redraw()
    }
  }

  apiMove(orig: Key, dest: Key, pieces?: cg.PiecesDiff, config?: cg.SetConfig): void {
    anim(state => {
      board.apiMove(state, orig, dest)

      if (pieces) {
        board.setPieces(state, pieces)
      }

      if (config) {
        setNewBoardState(state, config)
      }

    }, this)
  }

  apiNewPiece(piece: Piece, key: Key, config?: cg.SetConfig): void {
    anim(state => {
      board.apiNewPiece(state, piece, key)
      if (config) {
        setNewBoardState(state, config)
      }
    }, this)
  }

  playPremove = (): boolean => {

    if (this.state.premovable.current) {
      if (Boolean(anim(board.playPremove, this))) return true
      // if the premove couldn't be played, redraw to clear it up
      this.redraw()
    }
    return false
  }

  playPredrop = (validate: (d: cg.Drop) => boolean): boolean => {

    if (this.state.predroppable.current) {
      const result = board.playPredrop(this.state, validate)
      this.redraw()
      return result
    }
    return false
  }

  cancelPremove = (): void => {
    skipAnim(board.unsetPremove, this)
  }

  cancelPredrop = (): void => {
    skipAnim(board.unsetPredrop, this)
  }

  setCheck = (a: Color | boolean) => {
    skipAnim(state => board.setCheck(state, a), this)
  }

  cancelMove = (): void => {
    drag.cancel(this)
    skipAnim(state => board.cancelMove(state), this)
  }

  stop = () => {
    drag.cancel(this)
    skipAnim(state => board.stop(state), this)
  }

  explode = (keys: Key[]) => {
    if (!this.dom) return
    this.state.exploding = {
      stage: 1,
      keys: keys
    }
    this.redraw()
    setTimeout(() => {
      if (this.state.exploding) {
        this.state.exploding.stage = 2
        this.redraw()
      }
      setTimeout(() => {
        this.state.exploding = null
        this.redraw()
      }, 120)
    }, 120)
  }

  // no need to debounce: resizable only by orientation change
  private onOrientationChange = () => {
    const dom = this.dom
    if (dom) {
      // yolo
      clearTimeout(this.resizeTimeoutId)
      this.resizeTimeoutId = setTimeout(() => {
        dom.bounds = dom.board.getBoundingClientRect()
        this.redraw()
      }, 100)
    }
  }
}
