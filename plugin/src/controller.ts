import { connectBrowserPlugin } from '@exo/plugin-sdk/browser'
import { PREVIEW_VIEW_ID } from './preview-contract'

/**
 * Registration opts the declared surfaces into the running session: the
 * activity-bar Assets panel and the read-only Asset Preview content view.
 */
async function main(): Promise<void> {
  const connection = await connectBrowserPlugin()
  if (connection.mode !== 'register') {
    throw new Error('The Polyfork controller must be mounted in register mode.')
  }

  connection.registration.registerPanel('assets')
  connection.registration.registerContentView(PREVIEW_VIEW_ID)
  const ack = await connection.registration.complete()

  const missing = [
    ...(ack.acceptedPanels.includes('assets') ? [] : ['panel "assets"']),
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
