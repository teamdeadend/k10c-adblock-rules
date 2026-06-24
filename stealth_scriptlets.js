(function K10CStealthEngine() {
    'use strict';

    // =========================================================================
    // GLOBAL STATE & CONSTANTS
    // =========================================================================
    let isTrustedHost = false;
    let lastUserGestureTime = 0;
    const visibleVideosRegistry = [];
    let lastNotifiedUrl = null;
    let activeMediaElement = null;

    let lastPostedState = null;
    let lastPostedMediaSrc = null;
    let lastPostedTitle = null;
    let lastPostedDuration = null;

    let lastBridgeState = null;
    let lastBridgeTitle = null;
    let lastBridgeDuration = null;
    let lastBridgePosition = null;
    let lastBridgeTime = 0;

    const TRUSTED_REDIRECT_DOMAINS = [
        'google.com', 'google.co.in', 'googleadservices.com', 'google-analytics.com', 'googletagmanager.com',
        'facebook.com', 'facebook.net', 'fbcdn.net',
        'twitter.com', 'twitter.co', 'x.com', 'twimg.com',
        'github.com', 'githubusercontent.com',
        'apple.com', 'microsoft.com', 'live.com', 'outlook.com',
        'linkedin.com', 'pinterest.com', 'tumblr.com',
        'reddit.com', 'whatsapp.com', 'telegram.org',
        'paypal.com', 'stripe.com', 'wikipedia.org',
        'vimeo.com', 'dailymotion.com', 'spotify.com',
        'youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com',
        'instagram.com', 'cdninstagram.com',
        'recaptcha.net', 'gstatic.com', 'cloudflare.com',
        'disqus.com', 'disquscdn.com'
    ];

    // =========================================================================
    // GENERAL UTILITY FUNCTIONS & OUT-OF-SCOPE HELPERS
    // =========================================================================
    function handleError(err) {
        const c = globalThis.console;
        if (c && typeof c.debug === 'function') {
            c.debug(err);
        }
    }

    function updateGestureTime() {
        lastUserGestureTime = Date.now();
    }
    globalThis.addEventListener('click', updateGestureTime, true);
    globalThis.addEventListener('mousedown', updateGestureTime, true);
    globalThis.addEventListener('touchstart', updateGestureTime, true);

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
            handleError(e);
        }
        return false;
    }

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
            handleError(e);
        }
    }

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
            handleError(e);
        }
    };

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

    function sanitizeYtcfgValue(key, val) {
        if (!val) return val;
        try {
            if (key === 'PLAYER_CONFIG' && val.args) {
                sanitizeArgs(val.args);
            } else if (key === 'PLAYER_VARS') {
                sanitizeArgs(val);
            }
        } catch (e) {
            handleError(e);
        }
        return val;
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

    const handleStyleNode = function(node) {
        try {
            const sheetText = node.textContent || '';
            if (sheetText.includes('body') && sheetText.includes('overflow') && sheetText.includes('hidden')) {
                node.textContent = sheetText.replace(/body\s*{[^}]*overflow\s*:\s*hidden[^}]*}/gi, '');
                console.log('[K10C Stealth] Neutralized scroll lock in dynamic style element.');
            }
        } catch (err) {
            handleError(err);
        }
    };

    const handleIframeNode = function(node) {
        try {
            if (!node.hasAttribute('sandbox')) {
                node.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
                console.log('[K10C Stealth] Sandboxed dynamic iframe.');
                globalThis.ReactNativeWebView?.postMessage?.(JSON.stringify({
                    type: 'DEBUG_LOG',
                    category: 'Blocker',
                    message: 'Sandboxed dynamic iframe'
                }));
            }
        } catch (err) {
            handleError(err);
        }
    };

    const handleMutationNode = function(node) {
        const tag = node.tagName;
        if (tag === 'VIDEO') {
            registerActiveVideo(node);
        } else if (tag === 'SOURCE' && node.parentNode?.tagName === 'VIDEO') {
            registerActiveVideo(node.parentNode);
        } else if (tag === 'STYLE') {
            handleStyleNode(node);
        } else if (tag === 'IFRAME') {
            handleIframeNode(node);
        }
    };

    // =========================================================================
    // YOUTUBE RESPONSE SANITIZATION ENGINE
    // =========================================================================
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
                handleError(e);
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
            handleError(e);
            return val;
        }
    }

    function trapYtPlayer() {
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
    }

    function hookYtcfg(cfg) {
        if (!cfg || typeof cfg !== 'object') return;
        
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

    function trapYtCfg() {
        let originalYtcfg = globalThis.ytcfg;

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
    }

    function handleFetchedResponse(response, urlStr) {
        const clonedResponse = response.clone();
        return clonedResponse.text()
            .then(function(jsonText) {
                try {
                    const obj = JSON.parse(jsonText);
                    const result = sanitizePlayerResponse(obj);
                    if (result.modified) {
                        console.log('[K10C YouTube Shield Fetch] Successfully sanitized InnerTube response: ' + urlStr);
                        return new Response(JSON.stringify(result.obj), {
                            status: response.status,
                            statusText: response.statusText || 'OK',
                            headers: response.headers
                        });
                    }
                } catch (e) {
                    handleError(e);
                }
                return response;
            })
            .catch(function(e) {
                handleError(e);
                return response;
            });
    }

    function trapFetch() {
        if (globalThis.fetch) {
            const originalFetch = globalThis.fetch;
            globalThis.fetch = function() {
                const args = arguments;
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
                    return originalFetch.apply(this, args).then(function(response) {
                        return handleFetchedResponse(response, urlStr);
                    });
                }
                return originalFetch.apply(this, args);
            };
            makeNative(globalThis.fetch, 'fetch');
        }
    }

    function trapXhr() {
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
                handleError(e);
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
    }

    function setupYtAdSkipper() {
        let lastMutedState = false;
        let lastPlaybackRate = 1;
        let isAdActive = false;

        function skipYouTubeAds() {
            try {
                const player = document.querySelector('.html5-video-player');
                if (!player) return;
                
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
                handleError(e);
            }
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

            if (video.duration && Number.isFinite(video.duration) && video.currentTime < video.duration - 0.2) {
                video.currentTime = video.duration - 0.1;
            }
        }

        setInterval(skipYouTubeAds, 150);
    }

    // =========================================================================
    // MOBILE CLIENT INTERCEPTIONS & AD/POPUNDER BLOCKERS
    // =========================================================================
    function shouldBlockNavigation(urlStr) {
        if (!urlStr) return false;
        try {
            const urlLower = urlStr.trim().toLowerCase();
            if (!urlLower.startsWith('http://') && !urlLower.startsWith('https://')) {
                return false;
            }
            const urlObj = new URL(urlLower);
            if (urlObj.origin === globalThis.location.origin) {
                return false;
            }
            const hostname = urlObj.hostname.toLowerCase();
            const isTrusted = TRUSTED_REDIRECT_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
            return !isTrusted;
        } catch (e) {
            handleError(e);
            return false;
        }
    }

    function isInteractiveOrSmallElement(el) {
        const tagName = el.tagName.toUpperCase();
        const interactiveTags = ['A', 'BUTTON', 'INPUT', 'VIDEO', 'AUDIO', 'SELECT', 'TEXTAREA'];
        if (interactiveTags.includes(tagName)) {
            return true;
        }
        const role = el.getAttribute('role');
        if (role === 'button' || role === 'link') {
            return true;
        }
        const rect = el.getBoundingClientRect();
        const vpWidth = globalThis.innerWidth || document.documentElement.clientWidth;
        const vpHeight = globalThis.innerHeight || document.documentElement.clientHeight;
        if (rect.width < vpWidth * 0.45 || rect.height < vpHeight * 0.45) {
            return true;
        }
        return false;
    }

    function isClickjackingOverlay(el) {
        if (!el) return false;
        if (isInteractiveOrSmallElement(el)) {
            return false;
        }
        const rect = el.getBoundingClientRect();
        const style = globalThis.getComputedStyle(el);
        const pos = style.position;
        if (pos !== 'absolute' && pos !== 'fixed' && rect.top > 120) {
            return false;
        }
        const opacity = Number.parseFloat(style.opacity);
        if (opacity < 0.15) {
            return true;
        }
        const bg = style.backgroundColor;
        const isBgTransparent = bg === 'transparent' || 
                                bg === 'rgba(0, 0, 0, 0)' || 
                                bg.replace(/\s/g, '').startsWith('rgba(0,0,0,0') || 
                                style.background === 'none';
        const hasText = el.innerText && el.innerText.trim().length > 0;
        const hasImages = el.querySelector('img, svg, iframe, video, object') !== null;
        const hasBorder = Number.parseInt(style.borderWidth, 10) > 0 || style.borderStyle !== 'none';
        return (isBgTransparent && !hasText && !hasImages && !hasBorder);
    }

    function handleOverlaySuppression(element, e, clientX, clientY, eventName) {
        console.warn('[K10C Stealth] Suppressed invisible clickjacking overlay:', element);
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        element.style.setProperty('pointer-events', 'none', 'important');
        element.style.setProperty('display', 'none', 'important');

        let idOrClass = element.tagName;
        if (element.id) {
            idOrClass = '#' + element.id;
        } else if (element.className) {
            idOrClass = '.' + String(element.className).split(' ')[0];
        }
        
        globalThis.ReactNativeWebView?.postMessage?.(JSON.stringify({
            type: 'DEBUG_LOG',
            category: 'Overlay',
            message: 'Bypassed clickjacking overlay ' + idOrClass
        }));

        const realElement = document.elementFromPoint(clientX, clientY);
        if (realElement && realElement !== element) {
            console.log('[K10C Stealth] Re-routing click to:', realElement);
            let newEvent = null;
            if (eventName === 'mousedown') {
                newEvent = new MouseEvent('mousedown', {
                    clientX: clientX,
                    clientY: clientY,
                    bubbles: true,
                    cancelable: true,
                    view: globalThis
                });
            } else if (eventName === 'touchstart' && e.touches) {
                newEvent = new TouchEvent('touchstart', {
                    touches: Array.prototype.slice.call(e.touches),
                    targetTouches: Array.prototype.slice.call(e.targetTouches),
                    changedTouches: Array.prototype.slice.call(e.changedTouches),
                    bubbles: true,
                    cancelable: true,
                    view: globalThis
                });
            }
            if (newEvent) {
                realElement.dispatchEvent(newEvent);
                if (eventName === 'touchstart') {
                    setTimeout(() => {
                        try {
                            const clickEv = new MouseEvent('click', {
                                clientX: clientX,
                                clientY: clientY,
                                bubbles: true,
                                cancelable: true,
                                view: globalThis
                            });
                            realElement.dispatchEvent(clickEv);
                        } catch (err) {
                            handleError(err);
                        }
                    }, 50);
                }
            }
        }
    }

    function suppressAndReDispatch(e, clientX, clientY, eventName) {
        const element = document.elementFromPoint(clientX, clientY);
        if (isClickjackingOverlay(element)) {
            handleOverlaySuppression(element, e, clientX, clientY, eventName);
        }
    }

    function setupClickjackingBuster() {
        if (!isTrustedHost) {
            globalThis.addEventListener('mousedown', e => {
                try {
                    suppressAndReDispatch(e, e.clientX, e.clientY, 'mousedown');
                } catch (err) {
                    handleError(err);
                }
            }, true);

            globalThis.addEventListener('touchstart', e => {
                try {
                    if (e.touches && e.touches.length > 0) {
                        const touch = e.touches[0];
                        suppressAndReDispatch(e, touch.clientX, touch.clientY, 'touchstart');
                    }
                } catch (err) {
                    handleError(err);
                }
            }, true);
        }
    }

    function isLegitimateLinkClick(e) {
        try {
            if (e?.isTrusted === false) {
                return null;
            }
            const anchor = e.target.closest('a');
            if (!anchor) return null;
            let href = anchor.href;
            if (!href) return null;
            href = href.trim();
            if (!href.startsWith('http://') && !href.startsWith('https://')) {
                return null;
            }
            const urlObj = new URL(href);
            if (urlObj.pathname === globalThis.location.pathname && urlObj.hostname === globalThis.location.hostname && urlObj.hash) {
                return null;
            }
            return { anchor, href, hostname: urlObj.hostname };
        } catch (err) {
            handleError(err);
            return null;
        }
    }

    function setupLinkClickHijackInterceptor() {
        if (!isTrustedHost) {
            globalThis.addEventListener('click', e => {
                try {
                    const linkInfo = isLegitimateLinkClick(e);
                    if (linkInfo) {
                        const { href, anchor } = linkInfo;
                        console.log('[K10C Stealth] Bypassing click hijack for link:', href);
                        
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();

                        globalThis.ReactNativeWebView?.postMessage?.(JSON.stringify({
                            type: 'DEBUG_LOG',
                            category: 'Blocker',
                            message: 'Bypassed ad click-hijack: ' + href.substring(0, 50)
                        }));

                        if (anchor.target === '_blank' || e.button === 1 || e.ctrlKey) {
                            globalThis.ReactNativeWebView?.postMessage?.(JSON.stringify({
                                type: 'NAVIGATE_TO_URL',
                                url: href
                            }));
                        } else {
                            globalThis.location.href = href;
                        }
                    }
                } catch (err) {
                    handleError(err);
                }
            }, true);
        }
    }

    function shouldBypassEventBlocker(event) {
        if (!event) return false;
        const type = event.type;
        if (type !== 'click' && type !== 'mousedown' && type !== 'touchstart') {
            return false;
        }
        if (isTrustedHost) {
            return false;
        }
        try {
            const stack = new Error('Event Block Stack').stack || '';
            const stackLower = stack.toLowerCase();
            
            const adKeywords = [
                'popmagic', 'admaven', 'propeller', 'onclick', 'adcash', 'exoclick', 
                'popads', 'adsterra', 'monetag', 'propush', 'clickru', 'mgid',
                'adbreak', 'adroll', 'adform', 'juicyads', 'admitad', 'popunder',
                'clickhijack', 'setuppop', 'adblock', 'challenge', 'cloudflare'
            ];
            
            for (const keyword of adKeywords) {
                if (stackLower.includes(keyword)) {
                    return true;
                }
            }
            
            const urlRegex = /https?:\/\/[^\s/]+/g;
            let match;
            const currentOrigin = globalThis.location.origin;
            
            const trustedScriptDomains = [
                'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 
                'google.com', 'google.co.in', 'youtube.com', 'facebook.net', 
                'instagram.com', 'twitter.com', 'wikipedia.org', 'cloudflare.com',
                'recaptcha.net', 'gstatic.com'
            ];
            
            while ((match = urlRegex.exec(stack)) !== null) {
                const matchedUrl = match[0];
                const urlObj = new URL(matchedUrl);
                const host = urlObj.hostname.toLowerCase();
                
                if (urlObj.origin !== currentOrigin) {
                    const isTrusted = trustedScriptDomains.some(d => host === d || host.endsWith('.' + d));
                    if (!isTrusted) {
                        console.log('[K10C Stealth] Flagged untrusted third-party script in stack:', host);
                        return true;
                    }
                }
            }
        } catch (e) {
            handleError(e);
        }
        return false;
    }

    function setupEventPropagationTraps() {
        const originalPreventDefault = Event.prototype.preventDefault;
        Event.prototype.preventDefault = function() {
            if (shouldBypassEventBlocker(this)) {
                console.log('[K10C Stealth] Bypassed preventDefault call from ad script.');
                return;
            }
            return originalPreventDefault.apply(this, arguments);
        };
        makeNative(Event.prototype.preventDefault, 'preventDefault');

        const originalStopPropagation = Event.prototype.stopPropagation;
        Event.prototype.stopPropagation = function() {
            if (shouldBypassEventBlocker(this)) {
                console.log('[K10C Stealth] Bypassed stopPropagation call from ad script.');
                return;
            }
            return originalStopPropagation.apply(this, arguments);
        };
        makeNative(Event.prototype.stopPropagation, 'stopPropagation');

        const originalStopImmediatePropagation = Event.prototype.stopImmediatePropagation;
        Event.prototype.stopImmediatePropagation = function() {
            if (shouldBypassEventBlocker(this)) {
                console.log('[K10C Stealth] Bypassed stopImmediatePropagation call from ad script.');
                return;
            }
            return originalStopImmediatePropagation.apply(this, arguments);
        };
        makeNative(Event.prototype.stopImmediatePropagation, 'stopImmediatePropagation');
    }

    function trapWindowOpen() {
        const originalWindowOpen = globalThis.open;
        globalThis.open = function(url, name, specs) {
            if (shouldBlockNavigation(url)) {
                console.warn('[K10C Stealth] Blocked window.open to untrusted cross-origin URL:', url);
                globalThis.ReactNativeWebView?.postMessage?.(JSON.stringify({
                    type: 'DEBUG_LOG',
                    category: 'Popup',
                    message: 'Blocked window.open redirect to: ' + String(url).substring(0, 50)
                }));
                return null;
            }
            
            const timeSinceGesture = Date.now() - lastUserGestureTime;
            if (timeSinceGesture > 1500) {
                console.warn('[K10C Stealth] Blocked window.open due to lack of recent user gesture (' + timeSinceGesture + 'ms).');
                globalThis.ReactNativeWebView?.postMessage?.(JSON.stringify({
                    type: 'DEBUG_LOG',
                    category: 'Popup',
                    message: 'Blocked window.open: no user gesture (' + timeSinceGesture + 'ms)'
                }));
                return null;
            }
            return originalWindowOpen.call(globalThis, url, name, specs);
        };
        makeNative(globalThis.open, 'open');
    }

    function trapProgrammaticClicksAndSubmits() {
        const originalAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function() {
            if (shouldBlockNavigation(this.href)) {
                console.warn('[K10C Stealth] Blocked programmatic click on anchor to untrusted domain:', this.href);
                return;
            }
            return originalAnchorClick.apply(this, arguments);
        };
        makeNative(HTMLAnchorElement.prototype.click, 'click');

        const originalFormSubmit = HTMLFormElement.prototype.submit;
        HTMLFormElement.prototype.submit = function() {
            if (shouldBlockNavigation(this.action)) {
                console.warn('[K10C Stealth] Blocked programmatic form submit to untrusted domain:', this.action);
                return;
            }
            return originalFormSubmit.apply(this, arguments);
        };
        makeNative(HTMLFormElement.prototype.submit, 'submit');
    }

    const hookOnclickProperty = (proto) => {
        try {
            const desc = Object.getOwnPropertyDescriptor(proto, 'onclick');
            if (!desc) return;
            let localClick = desc.value || null;
            Object.defineProperty(proto, 'onclick', {
                get: function() { return localClick; },
                set: function(val) {
                    if (typeof val === 'function' && !isTrustedHost) {
                        const valStr = val.toString();
                        if (valStr.includes('popMagic') || valStr.includes('admaven') || valStr.includes('propeller')) {
                            console.warn('[K10C Stealth] Blocked malicious inline onclick handler.');
                            return;
                        }
                        const wrappedVal = function(e) {
                            try {
                                const res = val.apply(this, arguments);
                                if (res === false && shouldBypassEventBlocker(e)) {
                                    console.log('[K10C Stealth] Bypassed return false from inline ad handler.');
                                    return true;
                                }
                                return res;
                            } catch (err) {
                                handleError(err);
                                return val.apply(this, arguments);
                            }
                        };
                        makeNative(wrappedVal, 'onclick');
                        localClick = wrappedVal;
                    } else {
                        localClick = val;
                    }
                },
                configurable: true,
                enumerable: desc.enumerable
            });
        } catch (e) {
            handleError(e);
        }
    };

    function setupCosmeticStyles() {
        try {
            const style = document.createElement('style');
            style.id = 'k10c-cosmetic-styles';
            if (document.documentElement) {
                document.documentElement.appendChild(style);
            } else {
                document.addEventListener('DOMContentLoaded', () => {
                    document.documentElement.appendChild(style);
                });
            }
        } catch (e) {
            handleError(e);
        }

        globalThis.ReactNativeWebView?.postMessage?.(JSON.stringify({
            type: 'GET_COSMETIC_RULES',
            hostname: globalThis.location.hostname
        }));
    }

    // =========================================================================
    // MEDIA SNIFFER & VIEWPORT VISIBILITY OBSERVATION
    // =========================================================================
    function registerActiveVideo(el) {
        if (!el) return;
        if (isTrustedHost) return;
        
        const obs = globalThis.K10CActiveVideoObserver;
        if (obs) {
            obs.observe(el);
        } else {
            globalThis.K10CPendingVideos = globalThis.K10CPendingVideos || [];
            if (!globalThis.K10CPendingVideos.includes(el)) {
                globalThis.K10CPendingVideos.push(el);
            }
        }
    }

    function isNoiseUrl(lower) {
        return lower.includes('.ts') || 
               lower.includes('.m4s') || 
               lower.includes('.aac') || 
               lower.includes('.mp3') || 
               lower.includes('/segment/') || 
               lower.includes('/chunk/') || 
               lower.includes('/ad/') ||
               lower.includes('range=');
    }

    function isMediaUrl(lower) {
        return lower.includes('.mp4') || 
               lower.includes('.m3u8') || 
               lower.includes('.mpd') || 
               lower.includes('googlevideo.com') || 
               lower.includes('instagram.com/o1/') ||
               lower.includes('mime=video') ||
               lower.includes('video/');
    }

    function notifySniff(videoUrl, vectorSource, force) {
        if (!videoUrl || typeof videoUrl !== 'string') return;
        if (videoUrl.startsWith('blob:')) return;
        
        const lower = videoUrl.toLowerCase();
        if (isNoiseUrl(lower) && !force) return;
        if (lastNotifiedUrl === videoUrl) return;
        lastNotifiedUrl = videoUrl;

        if (!isMediaUrl(lower) && !force) return;

        let shortId = '';
        try {
            const cleanUrl = videoUrl.split('?')[0];
            shortId = btoa(cleanUrl).slice(-8).replace(/[^a-zA-Z0-9]/g, 'x');
        } catch (e) {
            handleError(e);
            shortId = Math.random().toString(36).substring(2, 10);
        }

        const msg = JSON.stringify({
            type: 'VIDEO_SNIFFED',
            id: shortId,
            url: videoUrl,
            title: document.title || 'Sniffed Media',
            vector: vectorSource
        });
        
        globalThis.ReactNativeWebView?.postMessage?.(msg);
    }

    function isAdOrTeaserClassOrId(classAndId) {
        const isYoutubeMoviePlayer = classAndId.includes('movie_player') || classAndId.includes('movie-player');
        if (isYoutubeMoviePlayer) {
            return false;
        }
        const adKeywords = ['preview', 'thumbnail', 'teaser', 'banner', 'ad-', 'ads', 'sponsor'];
        return adKeywords.some(keyword => classAndId.includes(keyword));
    }

    function isAdOrTeaserParent(element) {
        let parent = element.parentElement;
        let levels = 0;
        while (parent && levels < 4) {
            const classAndId = ((parent.className || '') + ' ' + (parent.id || '')).toLowerCase();
            if (isAdOrTeaserClassOrId(classAndId)) {
                return true;
            }
            parent = parent.parentElement;
            levels++;
        }
        return false;
    }

    function isValidVideoElement(element) {
        if (!element) return false;
        const width = element.clientWidth || 0;
        const height = element.clientHeight || 0;
        const area = width * height;

        if (area > 0 && area < 14400) {
            return false;
        }

        const isSmall = (area > 0 && area < 90000) || (width > 0 && width < 300) || (height > 0 && height < 300);
        if (element.muted && element.loop && isSmall) {
            return false;
        }
        if (element.autoplay && !element.controls && element.muted && isSmall) {
            return false;
        }

        try {
            if (isAdOrTeaserParent(element)) {
                return false;
            }
        } catch (e) {
            handleError(e);
        }

        return true;
    }

    function getHighestRatioVideo() {
        let maxRatio = 0;
        let targetVideo = null;
        for (const item of visibleVideosRegistry) {
            if (item.ratio > maxRatio) {
                maxRatio = item.ratio;
                targetVideo = item.element;
            }
        }
        return { targetVideo, maxRatio };
    }

    function updateVideoRatio(element, ratio, isIntersecting) {
        for (let i = visibleVideosRegistry.length - 1; i >= 0; i--) {
            if (visibleVideosRegistry[i].element === element) {
                visibleVideosRegistry.splice(i, 1);
            }
        }
        
        if (isIntersecting && ratio > 0) {
            visibleVideosRegistry.push({ element, ratio });
        }

        const highest = getHighestRatioVideo();
        const targetVideo = highest?.targetVideo;
        const maxRatio = highest?.maxRatio;

        if (targetVideo && maxRatio >= 0.5) {
            if (isValidVideoElement(targetVideo)) {
                const currentSrcUrl = targetVideo.currentSrc || targetVideo.src;
                if (currentSrcUrl && !currentSrcUrl.startsWith('blob:')) {
                    notifySniff(currentSrcUrl, 'Viewport_Intersection_Observer', false);
                }
            }
        } else {
            lastNotifiedUrl = null;
        }
    }

    function setupVideoSnifferObserver() {
        try {
            const activeVideoObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    updateVideoRatio(entry.target, entry.intersectionRatio, entry.isIntersecting);
                }
            }, {
                root: null,
                rootMargin: '0px',
                threshold: [0, 0.25, 0.5, 0.75, 1]
            });
            globalThis.K10CActiveVideoObserver = activeVideoObserver;
            
            globalThis.K10CPendingVideos = globalThis.K10CPendingVideos || [];
            if (globalThis.K10CPendingVideos.length > 0) {
                if (!isTrustedHost) {
                    for (const pendingVideo of globalThis.K10CPendingVideos) {
                        activeVideoObserver.observe(pendingVideo);
                    }
                }
                globalThis.K10CPendingVideos = [];
            }
        } catch (e) {
            handleError(e);
        }
    }

    function trapCreateObjectURL() {
        try {
            const originalCreateObjectURL = URL.createObjectURL;
            const sniffedRegistry = {};
            URL.createObjectURL = function(blob) {
                const objectUrl = originalCreateObjectURL.call(URL, blob);
                
                if (!isTrustedHost && blob?.size < 15 * 1024 * 1024 &&
                    (blob?.type?.includes('video') || blob?.type?.includes('mpegurl') || blob?.type?.includes('mp4'))) {
                    
                    if (!sniffedRegistry[objectUrl]) {
                        sniffedRegistry[objectUrl] = true;

                        const reader = new FileReader();
                        reader.onloadend = function() {
                            const base64Data = reader.result.split(',')[1];
                            let shortId = '';
                            try {
                                const cleanUrl = objectUrl.split('?')[0];
                                shortId = btoa(cleanUrl).slice(-8).replace(/[^a-zA-Z0-9]/g, 'x');
                            } catch (e) {
                                handleError(e);
                                shortId = Math.random().toString(36).substring(2, 10);
                            }

                            const msg = JSON.stringify({
                                type: 'VIDEO_SNIFFED',
                                id: shortId,
                                url: objectUrl,
                                title: document.title || 'Sniffed Media',
                                vector: 'URL_createObjectURL_Blob',
                                blobData: base64Data,
                                blobType: blob.type
                            });
                            
                            globalThis.ReactNativeWebView?.postMessage?.(msg);
                        };
                        reader.readAsDataURL(blob);
                    }
                }
                return objectUrl;
            };
            makeNative(URL.createObjectURL, 'createObjectURL');
        } catch (e) {
            handleError(e);
        }
    }

    function trapMediaElementProperties() {
        try {
            const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
            if (srcDescriptor) {
                Object.defineProperty(HTMLMediaElement.prototype, 'src', {
                    get: function() { return srcDescriptor.get.call(this); },
                    set: function(val) {
                        srcDescriptor.set.call(this, val);
                        registerActiveVideo(this);
                    },
                    configurable: true,
                    enumerable: true
                });
            }

            const srcObjDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
            if (srcObjDescriptor) {
                Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
                    get: function() { return srcObjDescriptor.get.call(this); },
                    set: function(val) {
                        srcObjDescriptor.set.call(this, val);
                        registerActiveVideo(this);
                    },
                    configurable: true,
                    enumerable: true
                });
            }
        } catch (e) {
            handleError(e);
        }

        try {
            const sourceSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src');
            if (sourceSrcDescriptor) {
                Object.defineProperty(HTMLSourceElement.prototype, 'src', {
                    get: function() { return sourceSrcDescriptor.get.call(this); },
                    set: function(val) {
                        sourceSrcDescriptor.set.call(this, val);
                        if (this.parentNode?.tagName === 'VIDEO') {
                            registerActiveVideo(this.parentNode);
                        }
                    },
                    configurable: true,
                    enumerable: true
                });
            }
        } catch (e) {
            handleError(e);
        }

        try {
            const originalPlay = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function() {
                registerActiveVideo(this);
                return originalPlay.apply(this, arguments);
            };
            makeNative(HTMLMediaElement.prototype.play, 'play');
        } catch (e) {
            handleError(e);
        }
    }

    function trapAttachShadow() {
        try {
            const originalAttachShadow = Element.prototype.attachShadow;
            
            function handleShadowNode(node) {
                if (node.nodeName === 'VIDEO' || node.nodeName === 'AUDIO') {
                    registerActiveVideo(node);
                } else if (node.nodeName === 'SOURCE' && node.parentNode?.nodeName === 'VIDEO') {
                    registerActiveVideo(node.parentNode);
                }
            }

            const shadowMutationHandler = mutations => {
                for (const mutation of mutations) {
                    if (mutation.addedNodes) {
                        for (const node of mutation.addedNodes) {
                            handleShadowNode(node);
                        }
                    }
                }
            };

            function scanShadowVideos(shadowRoot) {
                try {
                    const videos = shadowRoot.querySelectorAll('video');
                    for (const video of videos) {
                        registerActiveVideo(video);
                    }
                } catch (e) {
                    handleError(e);
                }
            }

            Element.prototype.attachShadow = function(initOptions) {
                if (initOptions?.mode === 'closed') {
                    initOptions.mode = 'open';
                }
                const shadowRoot = originalAttachShadow.call(this, initOptions);
                if (!shadowRoot) {
                    return shadowRoot;
                }
                const shadowObserver = new MutationObserver(shadowMutationHandler);
                shadowObserver.observe(shadowRoot, { childList: true, subtree: true });

                setTimeout(() => scanShadowVideos(shadowRoot), 100);
                return shadowRoot;
            };
            makeNative(Element.prototype.attachShadow, 'attachShadow');
        } catch (e) {
            handleError(e);
        }
    }

    // =========================================================================
    // PLAYBACK STATUS MONITORING & NOTIFICATION SYNC
    // =========================================================================
    function getArtworkUrl(title) {
        let artworkUrl = '';
        try {
            const ogImg = document.querySelector('meta[property="og:image"]');
            if (ogImg?.content) {
                artworkUrl = ogImg.content;
            } else {
                const linkImg = document.querySelector('link[rel="image_src"]');
                if (linkImg?.href) {
                    artworkUrl = linkImg.href;
                }
            }
            if (!artworkUrl && globalThis.location.hostname.includes('youtube.com')) {
                const urlParams = new URLSearchParams(globalThis.location.search);
                const videoId = urlParams.get('v');
                if (videoId) {
                    artworkUrl = 'https://img.youtube.com/vi/' + videoId + '/hqdefault.jpg';
                }
            }
        } catch (e) {
            handleError(e);
        }
        return artworkUrl;
    }

    function getMediaTitle() {
        let title = document.title || 'Sniffed Media';
        if (globalThis.location.hostname.includes('youtube.com')) {
            const ytTitleEl = document.querySelector('h1.media-item-title') || document.querySelector('.ytp-title-link') || document.querySelector('.slim-video-metadata-title');
            if (ytTitleEl) {
                title = ytTitleEl.textContent || title;
            }
        }
        return title.trim();
    }

    function checkShouldBridge(el, state, title, curTime) {
        if (state === 'ended' || state === 'stopped') {
            return true;
        }
        if (state !== lastBridgeState || title !== lastBridgeTitle || Math.abs((el.duration || 0) - (lastBridgeDuration || 0)) > 1) {
            return true;
        }
        if (lastBridgeTime > 0) {
            const elapsedSec = state === 'playing' ? (curTime - lastBridgeTime) / 1000 : 0;
            const expectedPos = lastBridgePosition + elapsedSec;
            const drift = Math.abs((el.currentTime || 0) - expectedPos);
            if (drift > 3) {
                return true;
            }
        }
        return false;
    }

    function postMediaStateToAudioBridge(el, state, title, artworkUrl, curTime) {
        if (!checkShouldBridge(el, state, title, curTime)) {
            return;
        }
        lastBridgeState = state;
        lastBridgeTitle = title;
        lastBridgeDuration = el.duration || 0;
        lastBridgePosition = el.currentTime || 0;
        lastBridgeTime = curTime;

        if (globalThis.K10CAudioBridge?.notifyMediaState) {
            try {
                globalThis.K10CAudioBridge.notifyMediaState(
                    state,
                    title,
                    el.duration || 0,
                    el.currentTime || 0,
                    artworkUrl
                );
            } catch (err) {
                handleError(err);
            }
        }
    }

    function postMediaStateToWebView(el, state, title, artworkUrl) {
        const mediaSrc = el.currentSrc || el.src || '';
        const isTransition = state !== lastPostedState || 
                             mediaSrc !== lastPostedMediaSrc || 
                             title !== lastPostedTitle || 
                             Math.abs((el.duration || 0) - (lastPostedDuration || 0)) > 1;
        if (isTransition || state === 'ended') {
            lastPostedState = state;
            lastPostedMediaSrc = mediaSrc;
            lastPostedTitle = title;
            lastPostedDuration = el.duration || 0;

            const msg = JSON.stringify({
                type: 'MEDIA_STATE_CHANGED',
                state: state,
                title: title,
                duration: el.duration || 0,
                position: el.currentTime || 0,
                artworkUrl: artworkUrl
            });
            globalThis.ReactNativeWebView?.postMessage?.(msg);
        }
    }

    function notifyMediaState(el, state) {
        if (!el) return;
        activeMediaElement = el;
        globalThis.K10CActiveMediaElement = el;
        
        const title = getMediaTitle();
        const artworkUrl = getArtworkUrl(title);

        const isPlaceholderTitle = title === '' || title === '- YouTube' || title === 'YouTube' || title === 'Sniffed Media';
        const isInvalidDuration = !el.duration || Number.isNaN(el.duration) || el.duration <= 0;
        if (isPlaceholderTitle && isInvalidDuration && state !== 'ended') {
            return;
        }

        const curTime = Date.now();
        postMediaStateToAudioBridge(el, state, title, artworkUrl, curTime);
        postMediaStateToWebView(el, state, title, artworkUrl);
    }

    function setupPlaybackMonitoringListeners() {
        document.addEventListener('play', e => {
            if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
                notifyMediaState(e.target, 'playing');
            }
        }, true);

        document.addEventListener('pause', e => {
            if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
                notifyMediaState(e.target, 'paused');
            }
        }, true);

        document.addEventListener('ended', e => {
            if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
                notifyMediaState(e.target, 'ended');
            }
        }, true);

        document.addEventListener('loadedmetadata', e => {
            if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
                notifyMediaState(e.target, e.target.paused ? 'paused' : 'playing');
            }
        }, true);

        document.addEventListener('durationchange', e => {
            if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
                notifyMediaState(e.target, e.target.paused ? 'paused' : 'playing');
            }
        }, true);

        document.addEventListener('playing', e => {
            if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
                notifyMediaState(e.target, 'playing');
            }
        }, true);

        document.addEventListener('canplay', e => {
            if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
                notifyMediaState(e.target, e.target.paused ? 'paused' : 'playing');
            }
        }, true);

        document.addEventListener('seeked', e => {
            if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
                notifyMediaState(e.target, e.target.paused ? 'paused' : 'playing');
            }
        }, true);

        setInterval(() => {
            if (activeMediaElement && !activeMediaElement.paused) {
                notifyMediaState(activeMediaElement, 'playing');
            }
        }, 3000);
    }

    // =========================================================================
    // DOM MUTATION OBSERVERS & PAGE SCANNERS
    // =========================================================================
    function setupMutationObserverAndScanner() {
        const mainMutationHandler = mutations => {
            for (const mutation of mutations) {
                if (mutation.addedNodes) {
                    for (const node of mutation.addedNodes) {
                        handleMutationNode(node);
                    }
                }
            }
        };

        try {
            const titleEl = document.querySelector('title');
            if (titleEl) {
                const titleObserver = new MutationObserver(() => {
                    if (activeMediaElement) {
                        notifyMediaState(activeMediaElement, activeMediaElement.paused ? 'paused' : 'playing');
                    }
                });
                titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
            }
        } catch (err) {
            handleError(err);
        }

        try {
            const observer = new MutationObserver(mainMutationHandler);
            observer.observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) {
            handleError(e);
        }
    }

    function setupDOMScannerFallback() {
        function scanPlayingMedia() {
            try {
                const allMedia = document.querySelectorAll('video, audio');
                for (const mediaItem of allMedia) {
                    if (mediaItem && !mediaItem.paused) {
                        notifyMediaState(mediaItem, 'playing');
                        break;
                    }
                }
            } catch (err) {
                handleError(err);
            }
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scanPlayingMedia);
        } else {
            scanPlayingMedia();
        }

        setInterval(() => {
            if (isTrustedHost) return;
            try {
                const videos = document.getElementsByTagName('video');
                for (const video of videos) {
                    registerActiveVideo(video);
                }
            } catch (e) {
                handleError(e);
            }
        }, 2000);

        function scanInitialVideos() {
            if (isTrustedHost) return;
            try {
                const initialVideos = document.querySelectorAll('video');
                for (const video of initialVideos) {
                    registerActiveVideo(video);
                }
            } catch (err) {
                handleError(err);
            }
        }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scanInitialVideos);
        } else {
            scanInitialVideos();
        }
    }

    function deconstructOverlays() {
        try {
            const genericSelectors = [
                "div[class*='ad-banner']", ".ytp-ad-overlay-container", 
                "div[id*='cookie-consent']", ".modal-overlay-backdrop"
            ];
            const selectorString = genericSelectors.join(', ');
            const nodes = document.querySelectorAll(selectorString);
            for (const node of nodes) {
                if (node.style.display !== 'none') {
                    node.style.setProperty('display', 'none', 'important');
                }
            }
        } catch (e) {
            handleError(e);
        }
    }

    function setupCosmeticOverlayBuster() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', deconstructOverlays);
        } else {
            deconstructOverlays();
        }
    }

    // =========================================================================
    // MAIN ENGINE INITIALIZATION ENTRY POINT
    // =========================================================================
    function applyDocumentVisibilityBypasses() {
        try { lockProperty(Document.prototype, 'hidden', false); } catch (e) { handleError(e); }
        try { lockProperty(Document.prototype, 'visibilityState', 'visible'); } catch (e) { handleError(e); }
        try { lockProperty(Document.prototype, 'webkitHidden', false); } catch (e) { handleError(e); }
        try { lockProperty(Document.prototype, 'webkitVisibilityState', 'visible'); } catch (e) { handleError(e); }
    }

    function applyYtBypasses() {
        try { trapYtPlayer(); } catch (e) { handleError(e); }
        try { trapYtCfg(); } catch (e) { handleError(e); }
        try { trapFetch(); } catch (e) { handleError(e); }
        try { trapXhr(); } catch (e) { handleError(e); }
        try { setupYtAdSkipper(); } catch (e) { handleError(e); }
    }

    function applyNavigationAndClickBypasses() {
        try { setupClickjackingBuster(); } catch (e) { handleError(e); }
        try { setupLinkClickHijackInterceptor(); } catch (e) { handleError(e); }
        try { setupEventPropagationTraps(); } catch (e) { handleError(e); }
        try { trapWindowOpen(); } catch (e) { handleError(e); }
        try { trapProgrammaticClicksAndSubmits(); } catch (e) { handleError(e); }
    }

    function applyClickHooks() {
        try { hookOnclickProperty(HTMLElement.prototype); } catch (e) { handleError(e); }
        try { hookOnclickProperty(Document.prototype); } catch (e) { handleError(e); }
        try { hookOnclickProperty(Window.prototype); } catch (e) { handleError(e); }
    }

    function applyMediaAndDomBypasses() {
        try { setupCosmeticStyles(); } catch (e) { handleError(e); }
        try { setupVideoSnifferObserver(); } catch (e) { handleError(e); }
        try { trapCreateObjectURL(); } catch (e) { handleError(e); }
        try { trapMediaElementProperties(); } catch (e) { handleError(e); }
        try { trapAttachShadow(); } catch (e) { handleError(e); }
        try { setupPlaybackMonitoringListeners(); } catch (e) { handleError(e); }
        try { setupMutationObserverAndScanner(); } catch (e) { handleError(e); }
        try { setupDOMScannerFallback(); } catch (e) { handleError(e); }
        try { setupCosmeticOverlayBuster(); } catch (e) { handleError(e); }
    }

    function initializeStealthEngine() {
        try {
            const currentHost = globalThis.location.hostname;
            if (currentHost) {
                const hostLower = currentHost.toLowerCase();
                const trustedDomains = [
                    'youtube.com', 'm.youtube.com', 'youtu.be', 
                    'google.com', 'google.co.in', 'wikipedia.org', 
                    'github.com', 'instagram.com', 'facebook.com'
                ];
                isTrustedHost = trustedDomains.some(d => hostLower === d || hostLower.endsWith('.' + d));
            }
        } catch (e) {
            handleError(e);
            isTrustedHost = false;
        }

        try { initializeServiceWorkerBypass(); } catch (e) { handleError(e); }
        
        applyDocumentVisibilityBypasses();
        applyYtBypasses();
        applyNavigationAndClickBypasses();
        applyClickHooks();
        applyMediaAndDomBypasses();

        console.log('[K10C Backend] Stealth scriptlets initialized with robust bypasses.');
    }

    function unregisterServiceWorkers(serviceWorkerObj) {
        if (!serviceWorkerObj || typeof serviceWorkerObj.getRegistrations !== 'function') return;
        serviceWorkerObj.getRegistrations()
            .then(function(registrations) {
                if (!registrations || registrations.length === 0) return;
                
                const promises = registrations.map(function(reg) {
                    return reg.unregister();
                });
                
                Promise.all(promises)
                    .then(function(results) {
                        if (results.some(Boolean)) {
                            console.log('[K10C YouTube Shield] Service Worker unregistered.');
                            clearCacheStorage();
                            
                            const hasReloaded = sessionStorage.getItem('k10c_sw_reloaded');
                            if (!hasReloaded) {
                                sessionStorage.setItem('k10c_sw_reloaded', 'true');
                                console.log('[K10C YouTube Shield] Reloading to apply bypass...');
                                globalThis.location.reload();
                            }
                        }
                    })
                    .catch(handleError);
            })
            .catch(handleError);
    }

    function clearCacheStorage() {
        if (!globalThis.caches || typeof globalThis.caches.keys !== 'function') return;
        globalThis.caches.keys()
            .then(function(keys) {
                if (keys && keys.length > 0) {
                    Promise.all(keys.map(function(key) { 
                        return globalThis.caches.delete(key); 
                    })).catch(handleError);
                }
            })
            .catch(handleError);
    }

    function mockServiceWorkerPrototypes() {
        try {
            const mockServiceWorkerContainer = {
                register: function() {
                    return Promise.resolve({
                        scope: '/',
                        unregister: function() { return Promise.resolve(true); },
                        update: function() { return Promise.resolve(); },
                        addEventListener: function() {},
                        removeEventListener: function() {}
                    });
                },
                addEventListener: function() {},
                removeEventListener: function() {},
                getRegistration: function() { return Promise.resolve(undefined); },
                getRegistrations: function() { return Promise.resolve([]); },
                get ready() {
                    return new Promise(function() {});
                },
                controller: null
            };

            if (globalThis.Navigator?.prototype) {
                Object.defineProperty(globalThis.Navigator.prototype, 'serviceWorker', {
                    get: function() { return mockServiceWorkerContainer; },
                    configurable: true,
                    enumerable: true
                });
            }
            Object.defineProperty(navigator, 'serviceWorker', {
                get: function() { return mockServiceWorkerContainer; },
                configurable: true,
                enumerable: true
            });
        } catch (e) {
            handleError(e);
        }
    }

    function initializeServiceWorkerBypass() {
        let originalServiceWorker = null;
        try {
            originalServiceWorker = navigator.serviceWorker;
        } catch (e) {
            handleError(e);
        }

        mockServiceWorkerPrototypes();

        if (originalServiceWorker) {
            unregisterServiceWorkers(originalServiceWorker);
        }
    }

    // Launch Engine
    initializeStealthEngine();
})();
