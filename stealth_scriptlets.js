(function K10CStealthEngine() {
    'use strict';

    function clearCacheStorage() {
        if (globalThis.caches && typeof globalThis.caches.keys === 'function') {
            globalThis.caches.keys().then(keys => {
                for (const key of keys) {
                    globalThis.caches.delete(key);
                }
            }).catch(e => {
                globalThis.console?.debug?.(e);
            });
        }
    }

    // Disable Service Workers & Clear Cache Storage
    try {
        if (navigator.serviceWorker) {
            navigator.serviceWorker.getRegistrations().then(registrations => {
                if (registrations && registrations.length > 0) {
                    let promises = [];
                    for (const registration of registrations) {
                        promises.push(registration.unregister());
                    }
                    Promise.all(promises).then(results => {
                        if (results.some(Boolean)) {
                            console.log('[K10C YouTube Shield] Service Worker unregistered.');
                            clearCacheStorage();

                            // Loop prevention guard: Reload at most once per session
                            let hasReloaded = sessionStorage.getItem('k10c_sw_reloaded');
                            if (!hasReloaded) {
                                sessionStorage.setItem('k10c_sw_reloaded', 'true');
                                console.log('[K10C YouTube Shield] Reloading to apply bypass...');
                                globalThis.location.reload();
                            }
                        }
                    }).catch(e => {
                        globalThis.console?.debug?.(e);
                    });
                }
            }).catch(e => {
                globalThis.console?.debug?.(e);
            });
        }
        // Poison Navigator prototype so YouTube cannot register Service Workers or redefine navigator.serviceWorker
        if (globalThis.Navigator?.prototype) {
            Object.defineProperty(globalThis.Navigator.prototype, 'serviceWorker', {
                get: function() { return undefined; },
                configurable: false,
                enumerable: true
            });
        }
        // Fallback direct navigator lock
        Object.defineProperty(navigator, 'serviceWorker', {
            get: function() { return undefined; },
            configurable: false,
            enumerable: true
        });
    } catch (e) {
        globalThis.console?.debug?.(e);
    }

    // Helper to check if Cloudflare challenge is active (either via URL, referrer, or DOM indicators)
    function isCloudflareChallengeActive() {
        try {
            const host = globalThis.location.hostname.toLowerCase();
            const path = globalThis.location.pathname.toLowerCase();
            if (host.includes('cloudflare') || 
                host.includes('challenges') || 
                path.includes('/cdn-cgi/') ||
                document.getElementById('cf-wrapper') || 
                document.getElementById('challenge-form') ||
                document.querySelector('.cf-browser-verification') ||
                document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                document.querySelector('script[src*="challenges.cloudflare.com"]')) {
                return true;
            }
        } catch (e) {
            globalThis.console?.debug?.(e);
        }
        return false;
    }

    // Helper to make overridden functions look native (toString spoofing)
    function makeNative(fn, name) {
        try {
            const toStringFn = function() { return `function ${name || fn.name || ''}() { [native code] }`; };
            Object.defineProperty(toStringFn, 'toString', {
                value: function() { return 'function toString() { [native code] }'; },
                writable: false,
                configurable: true
            });
            Object.defineProperty(fn, 'toString', {
                value: toStringFn,
                writable: false,
                configurable: true
            });
        } catch (e) {
            globalThis.console?.debug?.(e);
        }
    }

    // A. Page Visibility API Override
    const lockProperty = (proto, prop, val) => {
        try {
            const originalDescriptor = Object.getOwnPropertyDescriptor(proto, prop);
            if (!originalDescriptor) return;
            
            const getter = function() {
                if (isCloudflareChallengeActive()) {
                    return originalDescriptor.get.call(this);
                }
                return val;
            };
            makeNative(getter, `get ${prop}`);
            
            Object.defineProperty(proto, prop, {
                get: getter,
                set: function(v) {
                    if (isCloudflareChallengeActive() && originalDescriptor.set) {
                        originalDescriptor.set.call(this, v);
                    }
                },
                configurable: true,
                enumerable: originalDescriptor.enumerable
            });
        } catch (e) {
            globalThis.console?.debug?.(e);
        }
    };
    lockProperty(Document.prototype, 'hidden', false);
    lockProperty(Document.prototype, 'visibilityState', 'visible');
    lockProperty(Document.prototype, 'webkitHidden', false);
    lockProperty(Document.prototype, 'webkitVisibilityState', 'visible');

    // B. Suppress Visibility & Blur Events
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
        if (!isCloudflareChallengeActive()) {
            if (type === 'visibilitychange' || type === 'webkitvisibilitychange' || type === 'blur') {
                // Suppress event listener registration for window defocus / state suspend triggers
                return;
            }
        }
        return originalAddEventListener.apply(this, arguments);
    };
    makeNative(EventTarget.prototype.addEventListener, 'addEventListener');

    // C. Adsbygoogle Mock Array
    let mockQueue = [];
    Object.defineProperty(globalThis, 'adsbygoogle', {
        get: () => {
            if (isCloudflareChallengeActive()) return undefined;
            return mockQueue;
        },
        set: (val) => {
            if (isCloudflareChallengeActive()) return;
            if (Array.isArray(val)) {
                mockQueue = val;
                mockQueue.push = function(obj) {
                    Array.prototype.push.call(this, obj);
                    if (obj && typeof obj === 'object' && typeof obj.onload === 'function') {
                        setTimeout(obj.onload, 10);
                    }
                };
            }
        },
        configurable: true
    });

    // D. HTMLMediaElement Pause & Dimensions Mock
    const originalPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function() {
        if (isCloudflareChallengeActive()) {
            return originalPause.apply(this, arguments);
        }
        const stack = new Error('Stealth Pause Stack').stack || '';
        if (stack.includes('visibilityState') || stack.includes('hidden') || stack.includes('onVisibilityChange')) {
            console.log('[K10C Stealth] Ignored page visibility pause trigger.');
            return;
        }
        return originalPause.apply(this, arguments);
    };
    makeNative(HTMLMediaElement.prototype.pause, 'pause');
    
    // E. Bait-Element Dimensions override for Anti-Adblock checks
    const heightProp = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')?.get;
    const widthProp = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')?.get;
    if (heightProp && widthProp) {
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
            get: function() {
                if (isCloudflareChallengeActive()) {
                    return heightProp.call(this);
                }
                const classList = this.className || '';
                if (classList.includes('ad') || classList.includes('banner')) {
                    return 250; // Mock height of banner
                }
                return heightProp.call(this);
            },
            configurable: true
        });
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
            get: function() {
                if (isCloudflareChallengeActive()) {
                    return widthProp.call(this);
                }
                const classList = this.className || '';
                if (classList.includes('ad') || classList.includes('banner')) {
                    return 300; // Mock width of banner
                }
                return widthProp.call(this);
            },
            configurable: true
        });
    }
    
    // F. Sanitize YouTube Player Response
    function sanitizePlayerResponse(obj) {
        if (!obj || typeof obj !== 'object') return { obj, modified: false };
        let modified = false;

        const adFields = ['adPlacements', 'adSlots', 'playerAds', 'adGroups', 'adBreakHeartbeatParams'];

        function cleanAdFields(current) {
            for (const field of adFields) {
                if (field in current) {
                    if (Array.isArray(current[field])) {
                        current[field] = [];
                    } else {
                        delete current[field];
                    }
                    modified = true;
                }
            }
        }

        function cleanPropertyValue(current, key) {
            const val = current[key];
            if (val && typeof val === 'object') {
                recursiveClean(val);
                return;
            }
            
            if (typeof val !== 'string') return;
            if (key !== 'raw_player_response' && key !== 'player_response' && !val.includes('"adPlacements"')) {
                return;
            }

            try {
                const parsed = JSON.parse(val);
                if (parsed && typeof parsed === 'object') {
                    const cleanResult = sanitizePlayerResponse(parsed);
                    if (cleanResult.modified) {
                        current[key] = JSON.stringify(cleanResult.obj);
                        modified = true;
                    }
                }
            } catch (e) {
                globalThis.console?.debug?.(e);
            }
        }

        function recursiveClean(current) {
            if (!current || typeof current !== 'object') return;

            cleanAdFields(current);

            for (const key in current) {
                if (Object.hasOwn(current, key)) {
                    cleanPropertyValue(current, key);
                }
            }
        }

        recursiveClean(obj);
        return { obj, modified };
    }

    // G. Hook window.ytInitialPlayerResponse (Direct variable)
    let originalPlayerResponse = globalThis.ytInitialPlayerResponse;
    Object.defineProperty(globalThis, 'ytInitialPlayerResponse', {
        get: () => originalPlayerResponse,
        set: (val) => {
            if (val) {
                let result = sanitizePlayerResponse(val);
                if (result.modified) {
                    console.log('[K10C YouTube Shield] Sanitized window.ytInitialPlayerResponse properties.');
                }
                originalPlayerResponse = result.obj;
            } else {
                originalPlayerResponse = val;
            }
        },
        configurable: true,
        enumerable: true
    });
    if (originalPlayerResponse) {
        let result = sanitizePlayerResponse(originalPlayerResponse);
        originalPlayerResponse = result.obj;
    }

    // H. Hook window.ytplayer (SPA player variables)
    let originalYtplayer = globalThis.ytplayer;
    
    function sanitizeYtPlayerObject(yt) {
        if (!yt || typeof yt !== 'object') return;
        
        if (yt.config) {
            sanitizeConfig(yt.config);
        }
        
        let originalConfig = yt.config;
        Object.defineProperty(yt, 'config', {
            get: () => originalConfig,
            set: (newConfig) => {
                if (newConfig) {
                    sanitizeConfig(newConfig);
                }
                originalConfig = newConfig;
            },
            configurable: true,
            enumerable: true
        });
    }
    
    function sanitizeConfig(config) {
        if (!config || typeof config !== 'object') return;
        if (config.args) {
            sanitizeArgs(config.args);
        }
        let originalArgs = config.args;
        Object.defineProperty(config, 'args', {
            get: () => originalArgs,
            set: (newArgs) => {
                if (newArgs) {
                    sanitizeArgs(newArgs);
                }
                originalArgs = newArgs;
            },
            configurable: true,
            enumerable: true
        });
    }

    function sanitizeArgs(args) {
        if (!args || typeof args !== 'object') return;
        
        if (args.raw_player_response) {
            args.raw_player_response = trySanitizeJsonStringOrObject(args.raw_player_response);
        }
        let originalRaw = args.raw_player_response;
        Object.defineProperty(args, 'raw_player_response', {
            get: () => originalRaw,
            set: (newRaw) => {
                originalRaw = trySanitizeJsonStringOrObject(newRaw);
            },
            configurable: true,
            enumerable: true
        });

        if (args.player_response) {
            args.player_response = trySanitizeJsonStringOrObject(args.player_response);
        }
        let originalPlayer = args.player_response;
        Object.defineProperty(args, 'player_response', {
            get: () => originalPlayer,
            set: (newPlayer) => {
                originalPlayer = trySanitizeJsonStringOrObject(newPlayer);
            },
            configurable: true,
            enumerable: true
        });
    }

    function trySanitizeJsonStringOrObject(val) {
        if (!val) return val;
        try {
            let isString = typeof val === 'string';
            let obj = isString ? JSON.parse(val) : val;
            let result = sanitizePlayerResponse(obj);
            if (result.modified) {
                console.log('[K10C YouTube Shield] Sanitized player response in ytplayer config args.');
            }
            return isString ? JSON.stringify(result.obj) : result.obj;
        } catch (e) {
            globalThis.console?.debug?.(e);
            return val;
        }
    }

    Object.defineProperty(globalThis, 'ytplayer', {
        get: () => originalYtplayer,
        set: (val) => {
            sanitizeYtPlayerObject(val);
            originalYtplayer = val;
        },
        configurable: true,
        enumerable: true
    });

    if (originalYtplayer) {
        sanitizeYtPlayerObject(originalYtplayer);
    }

    // I. Hook window.ytcfg (YouTube Config Manager)
    let originalYtcfg = globalThis.ytcfg;
    function hookYtcfg(cfg) {
        if (!cfg || typeof cfg !== 'object') return;
        
        // Sanitize existing data
        if (cfg.data_) {
            sanitizeYtcfgObject(cfg.data_);
        }
        
        if (typeof cfg.set === 'function') {
            let originalSet = cfg.set;
            cfg.set = function(...args) {
                if (args[0] && typeof args[0] === 'object') {
                    sanitizeYtcfgObject(args[0]);
                } else if (typeof args[0] === 'string') {
                    if (args[0] === 'PLAYER_CONFIG' || args[0] === 'PLAYER_VARS') {
                        args[1] = sanitizeYtcfgValue(args[0], args[1]);
                    } else if (args[0] === 'EXPERIMENT_FLAGS') {
                        sanitizeExperimentFlags(args[1]);
                    }
                }
                return originalSet.apply(this, args);
            };
            makeNative(cfg.set, 'set');
        }

        if (typeof cfg.get === 'function') {
            let originalGet = cfg.get;
            cfg.get = function(key) {
                let val = originalGet.call(this, key);
                if (key === 'PLAYER_CONFIG' || key === 'PLAYER_VARS') {
                    return sanitizeYtcfgValue(key, val);
                } else if (key === 'EXPERIMENT_FLAGS') {
                    sanitizeExperimentFlags(val);
                }
                return val;
            };
            makeNative(cfg.get, 'get');
        }
    }

    function sanitizeExperimentFlags(flags) {
        if (!flags || typeof flags !== 'object') return;
        const keysToDisable = [
            'ad_blocker_detection',
            'ad_detection',
            'ab_dec',
            'ab_dec_2',
            'grec_dec',
            'blocker_detection',
            'detection'
        ];
        for (let key in flags) {
            if (typeof flags[key] === 'boolean') {
                for (let check of keysToDisable) {
                    if (key.toLowerCase().includes(check)) {
                        flags[key] = false;
                        console.log('[K10C YouTube Shield] Disabled anti-adblock experiment flag: ' + key);
                    }
                }
            } else if (flags[key] && typeof flags[key] === 'object') {
                sanitizeExperimentFlags(flags[key]);
            }
        }
    }

    function sanitizeYtcfgObject(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (obj.PLAYER_CONFIG) {
            obj.PLAYER_CONFIG = sanitizeYtcfgValue('PLAYER_CONFIG', obj.PLAYER_CONFIG);
        }
        if (obj.PLAYER_VARS) {
            obj.PLAYER_VARS = sanitizeYtcfgValue('PLAYER_VARS', obj.PLAYER_VARS);
        }
        if (obj.EXPERIMENT_FLAGS) {
            sanitizeExperimentFlags(obj.EXPERIMENT_FLAGS);
        }
    }

    function sanitizeYtcfgValue(key, val) {
        if (!val) return val;
        try {
            if (key === 'PLAYER_CONFIG' && val.args) {
                sanitizeArgs(val.args);
            } else if (key === 'PLAYER_VARS') {
                sanitizeArgs(val);
            }
        } catch (e) {
            globalThis.console?.debug?.(e);
        }
        return val;
    }

    Object.defineProperty(globalThis, 'ytcfg', {
        get: () => originalYtcfg,
        set: (val) => {
            hookYtcfg(val);
            originalYtcfg = val;
        },
        configurable: true,
        enumerable: true
    });

    if (originalYtcfg) {
        hookYtcfg(originalYtcfg);
    }

    // J. Robust Fetch API Interceptor (Intercept YouTube player API responses)
    if (globalThis.fetch) {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async function(...args) {
            const url = args[0];
            let urlStr = '';
            if (typeof url === 'string') {
                urlStr = url;
            } else if (url instanceof URL) {
                urlStr = url.href;
            } else if (url && typeof url === 'object') {
                if ('url' in url) {
                    urlStr = String(url.url);
                } else if ('href' in url) {
                    urlStr = String(url.href);
                }
            }
            
            if (urlStr.includes('youtubei/v1/player') ||
                urlStr.includes('youtubei/v1/next') ||
                urlStr.includes('youtubei/v1/get_watch')) {
                const response = await originalFetch(...args);
                const clonedResponse = response.clone();
                try {
                    const jsonText = await clonedResponse.text();
                    const obj = JSON.parse(jsonText);
                    let result = sanitizePlayerResponse(obj);
                    if (result.modified) {
                        console.log('[K10C YouTube Shield Fetch] Successfully sanitized InnerTube response: ' + urlStr);
                        return new Response(JSON.stringify(result.obj), {
                            status: response.status,
                            statusText: response.statusText || 'OK',
                            headers: response.headers
                        });
                    }
                    return response;
                } catch (e) {
                    globalThis.console?.debug?.(e);
                    return response;
                }
            }
            return originalFetch(...args);
        };
        makeNative(globalThis.fetch, 'fetch');
    }

    // K. Robust XHR Interceptor
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url ? url.toString() : '';
        return originalOpen.apply(this, arguments);
    };
    makeNative(XMLHttpRequest.prototype.open, 'open');

    const xhrResponseTextDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
    const xhrResponseDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
    const xhrSanitizedCache = new WeakMap();

    function sanitizeResponseText(xhr, val) {
        if (!val || typeof val !== 'string') return val;
        if (xhrSanitizedCache.has(xhr)) return xhrSanitizedCache.get(xhr).text;
        try {
            const obj = JSON.parse(val);
            const result = sanitizePlayerResponse(obj);
            const text = result.modified ? JSON.stringify(result.obj) : val;
            xhrSanitizedCache.set(xhr, { text, obj: result.obj });
            if (result.modified) {
                console.log('[K10C YouTube Shield XHR] Sanitized responseText for: ' + xhr._url);
            }
            return text;
        } catch (e) {
            globalThis.console?.debug?.(e);
            return val;
        }
    }

    if (xhrResponseTextDesc && xhrResponseDesc) {
        const getResponseText = function() {
            const val = xhrResponseTextDesc.get.call(this);
            if (this._url && (
                this._url.includes('youtubei/v1/player') ||
                this._url.includes('youtubei/v1/next') ||
                this._url.includes('youtubei/v1/get_watch')
            )) {
                return sanitizeResponseText(this, val);
            }
            return val;
        };
        makeNative(getResponseText, 'get responseText');
        Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
            get: getResponseText,
            configurable: true
        });

        const getResponse = function() {
            const val = xhrResponseDesc.get.call(this);
            if (this._url && (
                this._url.includes('youtubei/v1/player') ||
                this._url.includes('youtubei/v1/next') ||
                this._url.includes('youtubei/v1/get_watch')
            )) {
                if (this.responseType === '' || this.responseType === 'text') {
                    return sanitizeResponseText(this, val);
                } else if (this.responseType === 'json') {
                    if (xhrSanitizedCache.has(this)) return xhrSanitizedCache.get(this).obj;
                    const result = sanitizePlayerResponse(val);
                    xhrSanitizedCache.set(this, { text: JSON.stringify(result.obj), obj: result.obj });
                    if (result.modified) {
                        console.log('[K10C YouTube Shield XHR] Sanitized response JSON for: ' + this._url);
                    }
                    return result.obj;
                }
            }
            return val;
        };
        makeNative(getResponse, 'get response');
        Object.defineProperty(XMLHttpRequest.prototype, 'response', {
            get: getResponse,
            configurable: true
        });
    }

    // L. YouTube Ad Skipper & Accelerator Fallback
    (function() {
        let lastMutedState = false;
        let lastPlaybackRate = 1;
        let isAdActive = false;

        function detectAd(player) {
            const hasAdClass = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
            const hasAdOverlay = player.querySelector('.ytp-ad-player-overlay, .ytp-ad-overlay-container, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot') !== null;
            const videoAds = player.querySelector('.video-ads');
            const hasActiveVideoAds = videoAds && videoAds.children.length > 0;
            return hasAdClass || hasAdOverlay || hasActiveVideoAds;
        }

        function tryClickSkipButton(player) {
            const skipSelectors = [
                '.ytp-ad-skip-button',
                '.ytp-ad-skip-button-modern',
                '.ytp-ad-skip-button-slot',
                '.ytp-ad-skip-button-container',
                '.video-ads .ytp-ad-skip-button',
                '.ytp-ad-skip-button-slot button'
            ];
            for (const selector of skipSelectors) {
                const btn = player.querySelector(selector);
                if (btn && typeof btn.click === 'function') {
                    console.log('[K10C YouTube Shield] Clicking skip button:', selector);
                    btn.click();
                    return true;
                }
            }
            return false;
        }

        function handleActiveAd(video, player) {
            if (!isAdActive) {
                isAdActive = true;
                lastMutedState = video.muted;
                lastPlaybackRate = video.playbackRate === 16 ? 1 : video.playbackRate;
                console.log('[K10C YouTube Shield] Ad detected. Speeding up & muting...', {lastMutedState, lastPlaybackRate});
            }
            
            video.muted = true;
            if (video.playbackRate !== 16) {
                video.playbackRate = 16;
            }

            tryClickSkipButton(player);

            // Jumps to the end of ad if it is finite and not yet ended
            if (video.duration && Number.isFinite(video.duration) && video.currentTime < video.duration - 0.2) {
                video.currentTime = video.duration - 0.1;
            }
        }

        function skipYouTubeAds() {
            try {
                const player = document.querySelector('.html5-video-player');
                if (!player) return;
                
                // Select video element within the active player to prevent preview speed-up leaks
                const video = player.querySelector('video');
                if (!video) return;

                if (detectAd(player)) {
                    handleActiveAd(video, player);
                } else if (isAdActive) {
                    isAdActive = false;
                    video.muted = lastMutedState;
                    video.playbackRate = lastPlaybackRate === 16 ? 1 : lastPlaybackRate;
                    console.log('[K10C YouTube Shield] Ad ended. Restoring state:', {muted: lastMutedState, rate: lastPlaybackRate});
                }
            } catch (e) {
                globalThis.console?.debug?.(e);
            }
        }

        // Monitor player state frequently
        setInterval(skipYouTubeAds, 150);
    })();

    console.log('[K10C Backend] Stealth scriptlets initialized with robust bypasses.');
})();
