import { expect } from '@playwright/test'
import { test } from './fixtures/extension'

test('extension MV3 Service Worker loads and responds', async ({ serviceWorker, extensionId, collectedErrors }) => {
  // Verify the extension's Service Worker is loaded from dist/
  expect(serviceWorker).toBeDefined()
  expect(serviceWorker.url()).toMatch(/^chrome-extension:\/\/[a-z]{32}\//)

  // Verify the extension ID is a 32-character hex string
  expect(extensionId).toMatch(/^[a-z]{32}$/)

  // Verify the SW URL starts with the resolved extensionId
  expect(serviceWorker.url()).toMatch(`chrome-extension://${extensionId}/`)

  // Verify the Service Worker can evaluate a harmless expression
  const swEcho = await serviceWorker.evaluate<boolean>(() => {
    try {
      return true
    } catch {
      return false
    }
  })
  expect(swEcho).toBe(true)

  // Fail on any startup errors collected from the Service Worker or extension pages
  expect(collectedErrors).toEqual([])
})
