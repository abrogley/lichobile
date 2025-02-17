import * as stream from 'mithril/stream'
import { hasNetwork } from '../../utils'
import redraw from '../../utils/redraw'
import router from '../../router'
import socket from '../../socket'
import * as inboxXhr from '../inbox/inboxXhr'
import { ontap } from '../helper'
import SideMenuCtrl from '../shared/sideMenu/SideMenuCtrl'

let pingsTimeoutID: number

export const inboxUnreadCount = stream(0)
export const profileMenuOpen = stream(false)
export const mlat = stream(0)
export const ping = stream(0)

function onMenuOpen() {
  if (hasNetwork()) {
    socket.sendNoCheck('moveLat', true)
  }
  pingsTimeoutID = setTimeout(getServerLags, 2000)
}

function onMenuClose() {
  profileMenuOpen(false)
  clearTimeout(pingsTimeoutID)
  if (hasNetwork()) {
    socket.sendNoCheck('moveLat', false)
  }
}

export const mainMenuCtrl = new SideMenuCtrl(
  'left',
  'side_menu',
  'menu-close-overlay',
  onMenuOpen,
  onMenuClose
)

export function route(route: string) {
  return function() {
    return mainMenuCtrl.close().then(() => router.set(route))
  }
}

export function popup(action: () => void) {
  return function() {
    return mainMenuCtrl.close().then(() => {
      action()
      redraw()
    })
  }
}

export function toggleHeader() {
  const open = !profileMenuOpen()
  if (open) inboxXhr.unreadCount()
  .then(nb => {
    inboxUnreadCount(nb)
    redraw()
  })
  return profileMenuOpen(open)
}

export function getServerLags() {
  if (hasNetwork()) {
    socket.getCurrentPing()
    .then((p: number) => {
      ping(p)
      mlat(socket.getCurrentMoveLatency())
      if (mainMenuCtrl.isOpen) {
        redraw()
        setTimeout(getServerLags, 2000)
      }
    })
  }
}

export const backdropCloseHandler = ontap(() => {
  mainMenuCtrl.close()
})
