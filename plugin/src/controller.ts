import { connectBrowserPlugin } from '@exo/plugin-sdk/browser'
import { PREVIEW_VIEW_ID } from './preview-contract'
import { PARAMETERS_PANEL_ID } from './parameters-contract'

/**
 * Registration opts the declared surfaces into the running session: the
 * activity-bar Assets panel, the read-only Asset Preview content view and the
 * right side-bar Parameters panel it reveals.
 */
async function main(): Promise<void> {
  const connection = await connectBrowserPlugin()
  if (connection.mode !== 'register') {
    throw new Error('The Polyfork controller must be mounted in register mode.')
  }

  connection.registration.registerPanel('assets')
  connection.registration.registerPanel(PARAMETERS_PANEL_ID)
  connection.registration.registerContentView(PREVIEW_VIEW_ID)
  const ack = await connection.registration.complete()

  const missing = [
    ...(ack.acceptedPanels.includes('assets') ? [] : ['panel "assets"']),
    ...(ack.acceptedPanels.includes(PARAMETERS_PANEL_ID)
      ? []
      : [`panel "${PARAMETERS_PANEL_ID}"`]),
    ...(ack.acceptedContentViews.includes(PREVIEW_VIEW_ID)
      ? []
      : [`content view "${PREVIEW_VIEW_ID}"`]),
  ]
  if (missing.length > 0) {
    throw new Error(
      `The shell did not accept the Polyfork ${missing.join(' and ')}. Rejected: ${JSON.stringify(ack.rejected)}`,
    )
  }

  console.info('[polyfork] registered', {
    panels: ack.acceptedPanels,
    contentViews: ack.acceptedContentViews,
    rejected: ack.rejected,
  })
}

main().catch((error) => {
  document.body.textContent = `Polyfork failed to register: ${String(error)}`
  console.error('[polyfork] registration failed', error)
})
