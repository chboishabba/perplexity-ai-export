import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { config } from '../utils/config.js'
import { logger } from '../utils/logger.js'
import { confirm } from '@inquirer/prompts'

export class BrowserManager {
  static readonly BrowserLaunchError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'BrowserLaunchError'
    }
  }

  static readonly AuthError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'AuthError'
    }
  }

  static readonly ContextError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ContextError'
    }
  }

  static readonly NavigationError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'NavigationError'
    }
  }

  public browserInstance: Browser | null = null
  private activeContext: BrowserContext | null = null
  private activePage: Page | null = null

  async launch(): Promise<Page> {
    try {
      const hasSavedAuth = existsSync(config.authStoragePath)

      if (hasSavedAuth) {
        // Try the persisted browser state first. Perplexity sessions can remain
        // valid after the local file is older than a day, and discarding them
        // forces unnecessary SSO/MFA loops.
        await this.launchBrowser(config.headless)
        await this.initializeBrowserContext()
        await this.navigateToSettingsPage()
        const isLoggedIn = await this.verifyLoginStatus(this.getActivePage())

        if (isLoggedIn) {
          logger.success('Already logged in!')
          return this.getActivePage()
        }

        logger.warn(
          'Saved authentication could not be verified on settings; trying target URL anyway.'
        )
        return this.getActivePage()
      }

      // Need login: launch headful
      await this.launchBrowser(false)
      await this.initializeBrowserContext()
      await this.navigateToSettingsPage()
      await this.ensureUserIsAuthenticated()

      // If user wants headless, restart now that we are logged in
      if (config.headless !== false) {
        logger.info('Authentication successful. Restarting in headless mode...')
        await this.close()
        await this.launchBrowser(config.headless)
        await this.initializeBrowserContext()
        await this.navigateToSettingsPage()
      }

      return this.getActivePage()
    } catch (_error) {
      if (_error instanceof Error) throw _error
      throw new BrowserManager.BrowserLaunchError(`Unexpected error: ${String(_error)}`)
    }
  }

  async close(): Promise<void> {
    if (this.activePage) await this.activePage.close().catch(() => {})
    if (this.activeContext) await this.activeContext.close().catch(() => {})
    if (this.browserInstance) await this.browserInstance.close().catch(() => {})
    this.activePage = null
    this.activeContext = null
    this.browserInstance = null
  }

  private async launchBrowser(headless: boolean | 'new'): Promise<void> {
    try {
      this.browserInstance = await chromium.launch({
        headless: headless === 'new' ? true : headless,
        args: ['--disable-blink-features=AutomationControlled', '--disable-gpu'],
      })
    } catch (_error) {
      throw new BrowserManager.BrowserLaunchError(
        `Failed to launch browser: ${_error instanceof Error ? _error.message : String(_error)}`
      )
    }
  }

  private async initializeBrowserContext(): Promise<void> {
    if (!this.browserInstance) throw new BrowserManager.ContextError('Browser not initialized')

    if (existsSync(config.authStoragePath)) {
      logger.info('Loading saved authentication state...')
      try {
        const storageStateData = JSON.parse(readFileSync(config.authStoragePath, 'utf-8'))
        this.activeContext = await this.browserInstance.newContext({
          storageState: storageStateData,
        })
      } catch (_error) {
        logger.warn('Failed to load saved auth state, starting fresh.', _error)
        this.activeContext = await this.browserInstance.newContext()
      }
    } else {
      this.activeContext = await this.browserInstance.newContext()
    }
  }

  private async navigateToSettingsPage(): Promise<void> {
    if (!this.activeContext) {
      throw new BrowserManager.NavigationError('No browser context available')
    }
    this.activePage = await this.activeContext.newPage()
    const perplexitySettingsUrl = 'https://www.perplexity.ai/settings'
    try {
      await this.activePage.goto(perplexitySettingsUrl, {
        timeout: 3000,
      })
    } catch (_error) {
      throw new BrowserManager.NavigationError(
        `Failed to navigate to settings: ${_error instanceof Error ? _error.message : String(_error)}`
      )
    }
  }

  private async ensureUserIsAuthenticated(): Promise<void> {
    if (!this.activePage) {
      throw new BrowserManager.AuthError('Page not initialized')
    }

    const isActuallyLoggedIn = await this.verifyLoginStatus(this.activePage)

    if (isActuallyLoggedIn) {
      logger.success('Already logged in!')
      return
    }

    logger.info('Please log in manually in the browser window...')
    await confirm({
      message: 'Press Enter when you are logged in and on the settings page',
      default: true,
    })

    const perplexitySettingsUrl = 'https://www.perplexity.ai/settings'
    await this.activePage
      .goto(perplexitySettingsUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      })
      .catch((error) => {
        logger.warn(
          `Settings recheck navigation did not fully settle: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })

    const isLoginSuccessfulNow = await this.verifyLoginStatus(this.activePage)
    if (!isLoginSuccessfulNow) {
      throw new BrowserManager.AuthError(
        `Login verification failed. Current URL: ${this.activePage.url()}`
      )
    }

    await this.persistAuthenticationState()
    logger.success('Authentication state saved!')
  }

  private async verifyLoginStatus(page: Page): Promise<boolean> {
    await page.waitForTimeout(1000).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

    const userMenuElementCount = await page
      .locator('[data-testid="user-menu"]')
      .count()
      .catch(() => 0)

    if (userMenuElementCount > 0) {
      return true
    }

    const visibleLoginControlCount = await page
      .locator('button, a')
      .filter({ hasText: /^(log in|login|sign in|sign up)$/i })
      .count()
      .catch(() => 0)

    if (visibleLoginControlCount > 0) {
      return false
    }

    const currentUrl = page.url()
    if (currentUrl.includes('/account/details')) {
      return true
    }

    if (currentUrl.includes('/settings')) {
      const settingsText = await page
        .locator('body')
        .innerText({ timeout: 2000 })
        .catch(() => '')
      return (
        visibleLoginControlCount === 0 ||
        /account|profile|subscription|settings/i.test(settingsText)
      )
    }

    return false
  }

  private async persistAuthenticationState(): Promise<void> {
    if (!this.activeContext) {
      throw new BrowserManager.AuthError('No browser context available to save')
    }
    const currentStorageState = await this.activeContext.storageState()
    writeFileSync(config.authStoragePath, JSON.stringify(currentStorageState, null, 2))
  }

  private getActivePage(): Page {
    if (!this.activePage) {
      throw new BrowserManager.ContextError('Page not initialized')
    }
    return this.activePage
  }
}
