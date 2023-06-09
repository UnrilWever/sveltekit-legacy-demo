import './fast-selenium.cjs';

import { randomBytes } from 'node:crypto';

import { Builder /*, logging*/ } from 'selenium-webdriver';
import { Options as IEOptions } from 'selenium-webdriver/ie.js';

import { default as BrowserStackCapsList } from './browser-stack-caps.js';

import { test as navigationTest } from './navigation.js';
import { test as homeTest } from './home.js';
import { test as aboutTest } from './about.js';
import { test as sverdleTest } from './sverdle.js';

const browserStackUsername = process.env.BROWSERSTACK_USERNAME;
const browserStackAccessKey = process.env.BROWSERSTACK_ACCESS_KEY;
const browserStackProjectName = process.env.BROWSERSTACK_PROJECT_NAME;
const browserStackBuildName = process.env.BROWSERSTACK_BUILD_NAME || `local-build-${randomBytes(3*4).toString('base64')}`;
const browserStackLocalIdentifier = process.env.BROWSERSTACK_LOCAL_IDENTIFIER;

const tests = [
    { name: 'Navigation', func: navigationTest },
    { name: 'Home', func: homeTest },
    { name: 'About', func: aboutTest },
    { name: 'Sverdle', func: sverdleTest }
];

/** @type {(browser: string, caps?: import('./types.js').BrowserStackCaps) => Builder} */
const makeBuilder = (browser, caps) => {
    if (caps) {
        // In the case we're on BrowserStack testing

        if (!browserStackUsername || !browserStackAccessKey) {
            throw "Error: BROWSERSTACK_USERNAME or BROWSERSTACK_ACCESS_KEY" + 
                " environment variables aren't defined, but requested to run tests in BrowserStack.";
        }

        // Add the automated caps:
        caps['bstack:options'].local = true;
        caps['bstack:options'].networkLogs = true;
        caps['bstack:options'].consoleLogs = 'info';
        if (browserStackProjectName) {
            caps['bstack:options'].projectName = browserStackProjectName;
        }
        caps['bstack:options'].buildName = browserStackBuildName;
        if (browserStackLocalIdentifier) {
            caps['bstack:options'].localIdentifier = browserStackLocalIdentifier;
        }

        return new Builder()
            .usingServer(`http://${browserStackUsername}:${browserStackAccessKey}@hub.browserstack.com/wd/hub`)
            .withCapabilities(caps);
    }
    // otherwise

    switch (browser) {
        case 'ie':
            const options = new IEOptions();
            options.introduceFlakinessByIgnoringProtectedModeSettings(true);
            options.ignoreZoomSetting(true);

            return new Builder().forBrowser('internet explorer').setIeOptions(options);
        case 'edge':
            return new Builder().forBrowser('MicrosoftEdge');
        case 'safari':
            return new Builder().forBrowser('safari');
        case 'firefox':
            return new Builder().forBrowser('firefox');
        case 'chrome':
            return new Builder().forBrowser('chrome');
        default:
            throw `Error: Browser ${browser} isn't supported.`;
    }
};

/** @type {(browser: string, baseUrl: string, caps?: import('./types.js').BrowserStackCaps) => Promise<void>} */
async function runOn(browser, baseUrl, caps = undefined) {
    // Doesn't work for IE11 with `.setLoggingPrefs(prefs)`. Can we fix this?
    // const prefs = new logging.Preferences();
    // prefs.setLevel(logging.Type.BROWSER, logging.Level.DEBUG);

    const driver = await makeBuilder(browser, caps)
        /*.setLoggingPrefs(prefs)*/.build();

    /**
     * Log the message with the browser name
     * @param {string} message 
     * @returns 
     */
    const log = (message) => console.log(`[${browser}]: ${message}`);

    /** @type { import('./types.js').ExtraCaps } */
    const extraCaps = {
        actionsEnabled: true,
        ...(caps?.extraCaps ?? {})
    };
    
    const context = { baseUrl, driver, log, extraCaps };

    const cleanDriver = async () => {
        // Clean drive destruction consumes time for some reason, so don't perform this on CI,
        //  unless on BrowserStack (because we don't want it to marked as "TIMED OUT").
        if (!process.env.CI || caps) {
            log('ending...');
            await driver.quit();
        }
    }
    
    log('=== started ===');

    try {
        for (const test of tests) {
            log(`Starting test ${test.name}...`);
            await test.func(context);
            log(`Test ${test.name} has ended.`);
        }
        
        // This logging doesn't work on IE11 either
        //const logEntries = driver.manage().logs().get(logging.Level.ALL.name);
        //console.log("Logs: " + JSON.stringify(logEntries));

        if (caps) {
            // If on BrowserStack, report that the test finsihed
            await driver.executeScript(
                'browserstack_executor: {"action": "setSessionStatus", "arguments": {"status":"passed","reason": "All tests for this browser passed!"}}'
            );
        }
    } catch (err) {
        if (caps) {
            // If on BrowserStack, report that the test error
            await driver.executeScript(
                `browserstack_executor: {"action": "setSessionStatus", "arguments": {"status":"failed","reason": "Some error during testing: \"${
                    JSON.stringify(`${err}`).slice(1, -1)
                }\""}`
            );
        }

        await cleanDriver();

        console.error(`Error happen in ${browser}: ${err}`)

        throw err;// rethrow
    }

    await cleanDriver();

    log('=== finished ===');
}

await (async () => {
    const browsersArrStr = process.env.BROWSER || 'ie';
    const baseUrl = (process.argv.length >= 3) ? process.argv[2] : 'http://localhost:4173';

    const browsers = browsersArrStr.split(',').map(str => str.trim());

    const results = await Promise.allSettled(browsers.map((browser) => {
        if (browser === 'browser-stack') {
            return Promise.allSettled(BrowserStackCapsList.map(
                cap => runOn(`browser-stack:${cap['bstack:options'].sessionName}`, baseUrl, cap)));
        } else {
            return runOn(browser, baseUrl);
        }
    }));

    const firstError = /** @type { PromiseRejectedResult | undefined } */ (results
        .map((result) => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : result)
        .flat()
        .find((result) => result.status === 'rejected'));
    if (firstError) {
        throw firstError.reason;
    }
})();