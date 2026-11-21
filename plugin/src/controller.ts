import { connectBrowserPlugin } from '@exo/plugin-sdk/browser'

/**
 * Registration is a single panel. The manifest is the complete capability
 * declaration; this page only opts the declared panel into the running session.
 */
async function main(): Promise<void> {
  const connection = await connectBrowserPlugin()
  if (connection.mode !== 'register') {
    throw new Error('The Polyfork controller must be mounted in register mode.')
  }

  connection.registration.registerPanel('assets')
  const ack = await connection.registration.complete()

  if (!ack.acceptedPanels.includes('assets')) {
    throw new Error(
      `The shell did not accept the Assets panel. Rejected: ${JSON.stringify(ack.rejected)}`,
    )
  }

  console.info('[polyfork] registered', {
    panels: ack.acceptedPanels,
    rejected: ack.rejected,
  })
}

main().catch((error) => {
  document.body.textContent = `Polyfork failed to register: ${String(error)}`
  console.error('[polyfork] registration failed', error)
})
