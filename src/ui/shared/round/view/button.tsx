import * as h from 'mithril/hyperscript'
import * as throttle from 'lodash/throttle'
import { handleXhrError, hasNetwork } from '../../../../utils'
import * as gameApi from '../../../../lichess/game'
import session from '../../../../session'
import router from '../../../../router'
import gameStatus from '../../../../lichess/status'
import { OnlineGameData } from '../../../../lichess/interfaces/game'
import i18n from '../../../../i18n'
import spinner from '../../../../spinner'
import lobby from '../../../lobby'
import * as helper from '../../../helper'
import * as tournamentXhr from '../../../tournament/tournamentXhr'
import { getPGN } from '../roundXhr'
import OnlineRound from '../OnlineRound'

export default {
  standard(ctrl: OnlineRound, condition: (data: OnlineGameData) => boolean, icon: string, hint: string, socketMsg: string, onTap?: () => void) {
    return condition(ctrl.data) && hasNetwork() ? h('button', {
      key: socketMsg,
      className: socketMsg,
      'data-icon': icon,
      oncreate: helper.ontap(onTap ? onTap : () => { ctrl.socketIface.send(socketMsg) })
    }, i18n(hint)) : null
  },
  bookmark(ctrl: OnlineRound) {
    return session.isConnected() ? h('button', {
      key: 'bookmarkLink',
      oncreate: helper.ontap(ctrl.toggleBookmark),
      'data-icon': ctrl.data.bookmarked ? 't' : 's'
    }, [i18n('bookmarkThisGame')]) : null
  },
  shareLink(ctrl: OnlineRound) {
    return h('button', {
      key: 'shareGameLink',
      oncreate: helper.ontap(() => {
        window.plugins.socialsharing.share(null, null, null, gameApi.publicUrl(ctrl.data))
      })
    }, [i18n('shareGameURL')])
  },
  sharePGN(ctrl: OnlineRound) {
    function handler() {
      getPGN(ctrl.data.game.id)
      .then((PGN: string) => window.plugins.socialsharing.share(PGN))
      .catch(handleXhrError)
    }
    return (
      <button key="sharePGN" oncreate={helper.ontap(handler)}>
        {i18n('sharePGN')}
      </button>
    )
  },
  submitMove(ctrl: OnlineRound) {
    return h('div.negotiationButtonsWrapper', [
      h('p', i18n('moveConfirmation')),
      h('div.negotiationButtons', {
        className: ctrl.vm.submitFeedback ? 'loading' : ''
      }, [
        h('button.accept', {
          'data-icon': ctrl.vm.submitFeedback ? null : 'E',
          oncreate: helper.ontap(() => ctrl.submitMove(true)),
        }, ctrl.vm.submitFeedback ? spinner.getVdom('monochrome white') : null),
        h('button.decline', {
          'data-icon': 'L',
          oncreate: helper.ontap(() => ctrl.submitMove(false)),
        }),
      ])
    ])
  },
  resign: function(ctrl: OnlineRound) {
    return gameApi.resignable(ctrl.data) && !ctrl.vm.confirmResign ? h('button', {
      key: 'resign',
      className: 'resign',
      'data-icon': 'b',
      oncreate: helper.ontap(() => { ctrl.vm.confirmResign = true })
    }, i18n('resign')) : null
  },
  resignConfirmation(ctrl: OnlineRound) {
    return gameApi.resignable(ctrl.data) && ctrl.vm.confirmResign ? (
      <div className="negotiation">
        <div className="binary_choice_wrapper" key="resignConfirm">
          <button className="binary_choice" data-icon="E"
            oncreate={helper.ontap(() => { ctrl.socketIface.send('resign') })}
          >
            {i18n('resign')}
          </button>
          <button className="binary_choice" data-icon="L"
            oncreate={helper.ontap(() => { ctrl.vm.confirmResign = false })}
          >
            {i18n('cancel')}
          </button>
        </div>
      </div>
    ) : null
  },
  forceResign(ctrl: OnlineRound) {
    return gameApi.forceResignable(ctrl.data) ?
      h('div.force_resign_zone', {
        key: 'forceResignZone'
      }, [
        h('div.notice', i18n('theOtherPlayerHasLeftTheGameYouCanForceResignationOrWaitForHim')),
        h('div.binary_choice_wrapper', [
          h('button.binary_choice.left', {
            oncreate: helper.ontap(() => { ctrl.socketIface.send('resign-force') })
          }, i18n('forceResignation')),
          h('button.binary_choice.right', {
            oncreate: helper.ontap(() => { ctrl.socketIface.send('draw-force') })
          }, i18n('forceDraw'))
        ])
      ]) : null
  },
  threefoldClaimDraw(ctrl: OnlineRound) {
    return (ctrl.data.game.threefold) ? h('div.claim_draw_zone', {
      key: 'claimDrawZone'
    }, [
      h('div.notice', i18n('threefoldRepetition')),
      h.trust('&nbsp;'),
      h('button[data-icon=E]', {
        oncreate: helper.ontap(() => { ctrl.socketIface.send('draw-claim') })
      }, i18n('claimADraw'))
    ]) : null
  },
  cancelDrawOffer(ctrl: OnlineRound) {
    if (ctrl.data.player.offeringDraw) return h('div.negotiation', {
      key: 'cancelDrawOfferZone'
    }, [
      h('div.notice', i18n('drawOfferSent')),
    ])
    return null
  },
  answerOpponentDrawOffer(ctrl: OnlineRound) {
    if (ctrl.data.opponent.offeringDraw) return h('div.negotiation', {
      key: 'answerDrawOfferZone'
    }, [
      h('div.notice', i18n('yourOpponentOffersADraw')),
      h('div.binary_choice_wrapper', [
        h('button.binary_choice[data-icon=E]', {
          oncreate: helper.ontap(() => { ctrl.socketIface.send('draw-yes') })
        }, i18n('accept')),
        h('button.binary_choice[data-icon=L]', {
          oncreate: helper.ontap(() => { ctrl.socketIface.send('draw-no') })
        }, i18n('decline'))
      ])
    ])
    return null
  },
  cancelTakebackProposition(ctrl: OnlineRound) {
    if (ctrl.data.player.proposingTakeback) return h('div.negotiation', {
      key: 'cancelTakebackPropositionZone'
    }, [
      h('div.notice', i18n('takebackPropositionSent')),
      h('button[data-icon=L]', {
        oncreate: helper.ontap(() => { ctrl.socketIface.send('takeback-no') })
      }, i18n('cancel'))
    ])
    return null
  },
  answerOpponentTakebackProposition(ctrl: OnlineRound) {
    if (ctrl.data.opponent.proposingTakeback) return h('div.negotiation', {
      key: 'answerTakebackPropositionZone'
    }, [
      h('div.notice', i18n('yourOpponentProposesATakeback')),
      h('div.binary_choice_wrapper', [
        h('button.binary_choice[data-icon=E]', {
          oncreate: helper.ontap(() => { ctrl.socketIface.send('takeback-yes') })
        }, i18n('accept')),
        h('button.binary_choice[data-icon=L]', {
          oncreate: helper.ontap(() => { ctrl.socketIface.send('takeback-no') })
        }, i18n('decline'))
      ])
    ])
    return null
  },
  analysisBoard(ctrl: OnlineRound) {
    const d = ctrl.data
    if (gameApi.userAnalysable(d) || gameApi.replayable(d)) {
      return h('button', {
        oncreate: helper.ontap(ctrl.goToAnalysis)
      }, [h('span[data-icon=A].withIcon'), i18n('analysis')])
    }
    return null
  },
  analysisBoardIconOnly(ctrl: OnlineRound) {
    const d = ctrl.data
    if (gameApi.userAnalysable(d) || gameApi.replayable(d)) {
      return h('button.action_bar_button[data-icon=A]', {
        oncreate: helper.ontap(ctrl.goToAnalysis)
      })
    }
    return null
  },
  newOpponent(ctrl: OnlineRound) {
    const d = ctrl.data
    const newable = (gameStatus.finished(d) || gameStatus.aborted(d)) && (d.game.source === 'lobby' || d.game.source === 'pool')
    if (!ctrl.data.opponent.ai && newable) {
      return h('button[data-icon=r]', {
        oncreate: helper.ontap(() => {
          ctrl.hideActions()
          lobby.onNewOpponent(ctrl.data)
        })
      }, i18n('newOpponent'))
    }
    return null
  },
  rematch(ctrl: OnlineRound) {
    const d = ctrl.data
    const rematchable = !d.game.rematch && (gameStatus.finished(d) || gameStatus.aborted(d)) && !d.game.tournamentId && !d.game.boosted && (d.opponent.onGame || (!d.clock && d.player.user && d.opponent.user))
    if (ctrl.data.opponent.offeringRematch) {
      return h('div.negotiation', {
        key: 'answerOpponentRematchZone'
      }, [
        h('div.notice', i18n('yourOpponentWantsToPlayANewGameWithYou')),
        h('div.binary_choice_wrapper', [
          h('button.binary_choice[data-icon=E]', {
            oncreate: helper.ontap(() => { ctrl.socketIface.send('rematch-yes') })
          }, i18n('joinTheGame')),
          h('button.binary_choice[data-icon=L]', {
            oncreate: helper.ontap(() => { ctrl.socketIface.send('rematch-no') })
          }, i18n('declineInvitation'))
        ])
      ])
    } else if (ctrl.data.player.offeringRematch) {
      return h('div.negotiation', {
        key: 'cancelRematchZone'
      }, [
        h('div.notice', i18n('rematchOfferSent')),
        h('div.notice', i18n('waitingForOpponent')),
        h('button[data-icon=L]', {
          oncreate: helper.ontap(() => { ctrl.socketIface.send('rematch-no') })
        }, i18n('cancelRematchOffer'))
      ])
    } else {
      return h('button', {
        key: 'rematch',
        oncreate: helper.ontap(() => { ctrl.socketIface.send('rematch-yes') }),
        disabled: !rematchable,
      }, [h('span.fa.fa-refresh'), i18n('rematch')])
    }
  },
  moretime(ctrl: OnlineRound) {
    if (gameApi.moretimeable(ctrl.data)) return h('button[data-icon=O]', {
      key: 'moretime',
      oncreate: helper.ontap(throttle(() => { ctrl.socketIface.send('moretime') }, 600))
    }, i18n('giveNbSeconds', 15))
    return null
  },
  flipBoard(ctrl: OnlineRound) {
    const className = helper.classSet({
      'action_bar_button': true,
      highlight: ctrl.vm.flip
    })
    return (
      <button className={className} data-icon="B" key="flipboard"
        oncreate={helper.ontap(ctrl.flip)} />
    )
  },
  first(ctrl: OnlineRound) {
    const prevPly = ctrl.vm.ply - 1
    const enabled = ctrl.vm.ply !== prevPly && prevPly >= ctrl.firstPly()
    const className = helper.classSet({
      'action_bar_button': true,
      'fa': true,
      'fa-fast-backward': true,
      disabled: !enabled
    })
    return (
      <button className={className} key="fast-backward"
        oncreate={helper.ontap(ctrl.jumpFirst)} />
    )
  },
  backward(ctrl: OnlineRound) {
    const prevPly = ctrl.vm.ply - 1
    const enabled = ctrl.vm.ply !== prevPly && prevPly >= ctrl.firstPly()
    const className = helper.classSet({
      'action_bar_button': true,
      'fa': true,
      'fa-backward': true,
      disabled: !enabled
    })
    return (
      <button className={className} key="backward"
        oncreate={helper.ontap(ctrl.jumpPrev, undefined, ctrl.jumpPrev)} />
    )
  },
  forward(ctrl: OnlineRound) {
    const nextPly = ctrl.vm.ply + 1
    const enabled = ctrl.vm.ply !== nextPly && nextPly <= ctrl.lastPly()
    const className = helper.classSet({
      'action_bar_button': true,
      'fa': true,
      'fa-forward': true,
      disabled: !enabled
    })
    return (
      <button className={className} key="forward"
        oncreate={helper.ontap(ctrl.jumpNext, undefined, ctrl.jumpNext)} />
    )
  },
  last(ctrl: OnlineRound) {
    const nextPly = ctrl.vm.ply + 1
    const enabled = ctrl.vm.ply !== nextPly && nextPly <= ctrl.lastPly()
    const className = helper.classSet({
      'action_bar_button': true,
      'fa': true,
      'fa-fast-forward': true,
      disabled: !enabled
    })
    return (
      <button className={className} key="fast-forward"
        oncreate={helper.ontap(ctrl.jumpLast)} />
    )
  },
  notes(ctrl: OnlineRound) {
    return (
      <button className="action_bar_button fa fa-pencil" key="notes"
        oncreate={helper.ontap(
          () => ctrl.notes && ctrl.notes.open(),
          () => window.plugins.toast.show(i18n('notes'), 'short', 'bottom')
        )} />
    )
  },
  returnToTournament(ctrl: OnlineRound) {
    function handler() {
      ctrl.hideActions()
      const url = `/tournament/${ctrl.data.game.tournamentId}`
      if (ctrl.data.tv) {
        router.set(url)
      } else {
        router.set(url, true)
      }
    }
    return (
      <button key="returnToTournament" oncreate={helper.ontap(handler)}>
        <span className="fa fa-trophy" />
        {i18n('backToTournament')}
      </button>
    )
  },
  withdrawFromTournament(ctrl: OnlineRound, tournamentId: string) {
    function handler() {
      ctrl.hideActions()
      tournamentXhr.withdraw(tournamentId)
      router.set(`/tournament/${tournamentId}`, true)
    }
    return (
      <button key="withdrawFromTournament" oncreate={helper.ontap(handler)}>
        <span className="fa fa-flag" />
        Pause
      </button>
    )
  },
  goBerserk(ctrl: OnlineRound) {
    if (!gameApi.berserkableBy(ctrl.data)) return null
    if (ctrl.vm.goneBerserk[ctrl.data.player.color]) return null
    function handler() {
      ctrl.hideActions()
      ctrl.goBerserk()
    }
    return (
      <button className="berserk" key="goBerserk" oncreate={helper.ontap(handler)}>
        <span data-icon="`" /> GO BERSERK!<br/>
        <small>Half the time, bonus point</small>
      </button>
    )
  }
}
