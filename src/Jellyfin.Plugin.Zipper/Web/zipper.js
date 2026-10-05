(function () {
    'use strict';

    var injectedScriptUrl = document.currentScript && document.currentScript.src || '';
    var VERSION = '1';
    var MODES = [
        { value: 'mediaAndSubtitles', label: 'Media + subtitles' },
        { value: 'mediaOnly', label: 'Media only' },
        { value: 'subtitlesOnly', label: 'Subtitles only' }
    ];
    var SUPPORTED_TYPES = { movie: true, episode: true, season: true, series: true };
    var ACTIVE_STATES = { ready: true, validating: true, streaming: true, cancelling: true };
    // Jellyfin item IDs are GUID-shaped, but legacy MD5 GUIDs need not use RFC version/variant nibbles.
    var UUID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
    var TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
    var API_ERROR_TEXT = {
        authenticationRequired: { key: 'apiError.authenticationRequired', fallback: 'Sign in with a Jellyfin user account to use Zipper.' },
        downloadBusy: { key: 'apiError.downloadBusy', fallback: 'Too many Zipper downloads are active. Try again shortly.' },
        downloadNotAllowed: { key: 'apiError.downloadNotAllowed', fallback: 'This Jellyfin account cannot download one or more selected items.' },
        emptyPackage: { key: 'apiError.emptyPackage', fallback: 'No downloadable files are available in this selection.' },
        entryLimitExceeded: { key: 'apiError.entryLimitExceeded', fallback: 'This package exceeds the server file-count limit.' },
        filenameCollision: { key: 'apiError.filenameCollision', fallback: 'Some selected files share a filename. Choose fewer subtitle tracks to preserve their original names.' },
        invalidMode: { key: 'apiError.invalidMode', fallback: 'Choose a supported package type.' },
        invalidRequest: { key: 'apiError.invalidRequest', fallback: 'Choose a valid Jellyfin item.' },
        invalidSelection: { key: 'apiError.invalidSelection', fallback: 'One or more package selections are invalid. Review the selection and try again.' },
        invalidServerLimits: { key: 'apiError.invalidServerLimits', fallback: 'Zipper limits are not configured correctly.' },
        itemLimitExceeded: { key: 'apiError.itemLimitExceeded', fallback: 'This package exceeds the server item limit. Choose one or more seasons instead.' },
        itemUnavailable: { key: 'apiError.itemUnavailable', fallback: 'One or more selected items are unavailable.' },
        jobLimit: { key: 'apiError.jobLimit', fallback: 'The temporary package history limit has been reached.' },
        jobNotRetryable: { key: 'apiError.jobNotRetryable', fallback: 'This package is still active.' },
        jobUnavailable: { key: 'apiError.jobUnavailable', fallback: 'This package is unavailable.' },
        mediaSourceUnavailable: { key: 'apiError.mediaSourceUnavailable', fallback: 'The selected media version is unavailable.' },
        noSubtitles: { key: 'apiError.noSubtitles', fallback: 'No supported external subtitles matched this selection.' },
        packageChanged: { key: 'apiError.packageChanged', fallback: 'The selected media or subtitle files changed. Create a new package before downloading.' },
        planningBusy: { key: 'apiError.planningBusy', fallback: 'Zipper is preparing other packages. Try again shortly.' },
        sizeLimitExceeded: { key: 'apiError.sizeLimitExceeded', fallback: 'This package exceeds the server size limit.' },
        sourceUnavailable: { key: 'apiError.sourceUnavailable', fallback: 'A selected media or subtitle file is unavailable.' },
        ticketLimit: { key: 'apiError.ticketLimit', fallback: 'This account has too many unused download tickets.' },
        ticketUnavailable: { key: 'apiError.ticketUnavailable', fallback: 'This download ticket is expired or already used. Create a fresh package to download again.' },
        tooManyParts: { key: 'apiError.tooManyParts', fallback: 'This item has too many media parts to package.' },
        tooManySources: { key: 'apiError.tooManySources', fallback: 'This item has too many media versions to package.' },
        tooManySubtitleTracks: { key: 'apiError.tooManySubtitleTracks', fallback: 'This media source has too many associated subtitle tracks. Ask the server administrator to correct the track metadata or choose media-only mode.' },
        trackLimitExceeded: { key: 'apiError.trackLimitExceeded', fallback: 'This selection has too many subtitle tracks to package safely. Choose fewer episodes.' },
        unsafeFilename: { key: 'apiError.unsafeFilename', fallback: 'A selected file has a filename that cannot be safely preserved in this package.' },
        unsupportedItem: { key: 'apiError.unsupportedItem', fallback: 'Choose an enabled movie, episode, season, or series.' },
        unsupportedSubtitle: { key: 'apiError.unsupportedSubtitle', fallback: 'The selected subtitle tracks are not available in an enabled file format.' },
        zipperDisabled: { key: 'apiError.zipperDisabled', fallback: 'Zipper is disabled by the server administrator.' },
        internalError: { key: 'apiError.internalError', fallback: 'Zipper could not complete this request. Try again.' },
        requestCancelled: { key: 'apiError.requestCancelled', fallback: 'The request was cancelled.' },
        downloadCancelled: { key: 'apiError.downloadCancelled', fallback: 'The package download was cancelled.' },
        transferInterrupted: { key: 'apiError.transferInterrupted', fallback: 'The package transfer was interrupted. Try again.' }
    };
    var WARNING_TEXT = {
        'A media version has more than 256 associated subtitle tracks. Choose media only or another version.': localized('warning.tooManyTracks', 'A media version has more than 256 associated subtitle tracks. Choose media only or another version.'),
        'No supported external subtitle tracks matched. The original media remains unchanged.': localized('warning.noExternalSubtitles', 'No supported external subtitle tracks matched. The original media remains unchanged.'),
        'Additional media versions are available; the primary version was selected.': localized('warning.alternativeVersions', 'Additional media versions are available; the primary version was selected.'),
        "The primary media version was not available; Jellyfin's first accessible version was selected.": localized('warning.primaryFallback', "The primary media version was not available; Jellyfin's first accessible version was selected."),
        'Some associated external subtitle tracks use formats the server administrator has not enabled.': localized('warning.disabledSubtitleFormats', 'Some associated external subtitle tracks use formats the server administrator has not enabled.'),
        'An associated external subtitle track has no safe local file path and was left out.': localized('warning.unsafeSubtitlePath', 'An associated external subtitle track has no safe local file path and was left out.'),
        'A VobSub subtitle track is disabled because its paired .sub format is disabled.': localized('warning.vobsubSubDisabled', 'A VobSub subtitle track is disabled because its paired .sub format is disabled.'),
        'A VobSub subtitle track is missing its paired .sub file and was left out.': localized('warning.vobsubSubMissing', 'A VobSub subtitle track is missing its paired .sub file and was left out.'),
        'A VobSub subtitle track is disabled because its paired .idx format is disabled.': localized('warning.vobsubIdxDisabled', 'A VobSub subtitle track is disabled because its paired .idx format is disabled.'),
        'A VobSub subtitle track is missing its paired .idx file and was left out.': localized('warning.vobsubIdxMissing', 'A VobSub subtitle track is missing its paired .idx file and was left out.'),
        'Some associated subtitle tracks use formats the administrator has not enabled.': localized('warning.disabledFormats', 'Some associated subtitle tracks use formats the administrator has not enabled.'),
        'A VobSub subtitle track is missing its paired .sub file or its format is disabled.': localized('warning.vobsubSubUnavailable', 'A VobSub subtitle track is missing its paired .sub file or its format is disabled.'),
        'A VobSub subtitle track is missing its paired .idx file or its format is disabled.': localized('warning.vobsubIdxUnavailable', 'A VobSub subtitle track is missing its paired .idx file or its format is disabled.')
    };
    var JOB_ERROR_TEXT = {
        'The package transfer was interrupted.': localized('center.jobError.interrupted', 'The package transfer was interrupted. Try again.'),
        'Package cancelled.': localized('center.jobError.cancelled', 'Package cancelled.'),
        'The download ticket expired. Create a new package to download again.': localized('center.jobError.expired', 'The download ticket expired. Create a new package to download again.'),
        'Too many active downloads are using the server. Retry this package shortly.': localized('center.jobError.busy', 'Too many active downloads are using the server. Retry this package shortly.'),
        'Package cancelled or client disconnected.': localized('center.jobError.disconnected', 'Package cancelled or client disconnected.'),
        'A selected source file changed or became unavailable during the transfer.': localized('center.jobError.sourceUnavailable', 'A selected source file changed or became unavailable during the transfer.'),
        'A selected source file changed or became unavailable.': localized('center.jobError.sourceUnavailable', 'A selected source file changed or became unavailable.'),
        'The package stream failed.': localized('center.jobError.failed', 'The package stream failed.')
    };

    if (window.__zipperWeb && window.__zipperWeb.version === VERSION) {
        window.__zipperWeb.wake();
        return;
    }

    if (window.__zipperWeb && typeof window.__zipperWeb.dispose === 'function') {
        window.__zipperWeb.dispose();
    }

    var state = {
        started: false,
        identityKey: '',
        caps: null,
        capIdentity: '',
        capRequest: 0,
        capPending: false,
        capUnavailable: false,
        capRetryAfter: 0,
        observer: null,
        scanFrame: 0,
        identityTimer: 0,
        routeKey: getRouteKey(),
        pendingContext: null,
        ambiguousContextUntil: 0,
        modal: null,
        pollTimer: 0,
        jobRequest: 0,
        jobLoading: false,
        jobPollingUnavailableFor: '',
        downloads: new Map(),
        localePromise: null,
        localeObserver: null,
        clientIds: new WeakMap(),
        nextClientId: 1
    };

    var translations = window.ZipperI18n && typeof window.ZipperI18n.create === 'function'
        ? window.ZipperI18n.create(function (language) {
            try {
                var client = getClient();
                var localeAddress = client && typeof client.getUrl === 'function'
                    ? client.getUrl('Zipper/Locales/' + language)
                    : injectedScriptUrl ? new URL('Locales/' + language, new URL(injectedScriptUrl, window.location.href)).href : '';
                if (!localeAddress) return '';
                var localeUrl = new URL(localeAddress, window.location.href);
                localeUrl.search = '';
                localeUrl.hash = '';
                return localeUrl.origin === window.location.origin ? localeUrl.href : '';
            } catch (_) { return ''; }
        })
        : { load: function () { return Promise.resolve(); }, text: function (_key, fallback, values) { return interpolateText(fallback, values); }, plural: function (_key, count, fallbacks, values) { return interpolateText((Number(count) === 1 ? fallbacks.one : fallbacks.other) || fallbacks.other || '', Object.assign({}, values || {}, { count: count })); }, number: function (value) { return String(value); }, locale: function () { return 'en'; } };

    var publicApi = { version: VERSION, wake: wake, dispose: dispose };
    window.__zipperWeb = publicApi;

    function getClient() {
        return window.ApiClient || null;
    }

    function clientKey(client) {
        if (!client || (typeof client !== 'object' && typeof client !== 'function')) return 'none';
        if (!state.clientIds.has(client)) state.clientIds.set(client, state.nextClientId++);
        return String(state.clientIds.get(client));
    }

    function identity() {
        var client = getClient();
        var serverId = '';
        var userId = '';
        try { serverId = client && typeof client.serverId === 'function' ? String(client.serverId() || '') : ''; } catch (_) { }
        try { userId = client && typeof client.getCurrentUserId === 'function' ? String(client.getCurrentUserId() || '') : ''; } catch (_) { }
        return {
            client: client,
            clientId: clientKey(client),
            serverId: serverId,
            userId: userId,
            key: clientKey(client) + '|' + serverId + '|' + userId
        };
    }

    function getRouteKey() {
        return window.location.pathname + window.location.search + window.location.hash;
    }

    function interpolateText(value, values) {
        return String(value || '').replace(/\{([a-zA-Z0-9_]+)\}/g, function (match, name) {
            return values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match;
        });
    }

    function localized(key, fallback, values) {
        return { zipperLocalized: true, key: key, fallback: fallback, values: values || null };
    }

    function translate(key, fallback, values) {
        return translations.text(key, fallback, values);
    }

    function applyLocalizedText(node, value) {
        if (!node || !value || value.zipperLocalized !== true) return;
        node._zipperLocalizedText = value;
        node.setAttribute('data-zipper-i18n', 'text');
        node.textContent = translate(value.key, value.fallback, value.values);
    }

    function applyLocalizedAttribute(node, attribute, value) {
        if (!node || !value || value.zipperLocalized !== true) return;
        node._zipperLocalizedAttributes = node._zipperLocalizedAttributes || Object.create(null);
        node._zipperLocalizedAttributes[attribute] = value;
        node.setAttribute('data-zipper-i18n-attr', 'true');
        node.setAttribute(attribute, translate(value.key, value.fallback, value.values));
    }

    function setTranslatedText(node, key, fallback, values) {
        applyLocalizedText(node, localized(key, fallback, values));
    }

    function relocalizeOwnedText() {
        document.querySelectorAll('[data-zipper-i18n="text"]').forEach(function (node) {
            if (node._zipperLocalizedText) {
                node.textContent = translate(node._zipperLocalizedText.key, node._zipperLocalizedText.fallback, node._zipperLocalizedText.values);
            }
        });
        document.querySelectorAll('[data-zipper-i18n-attr="true"]').forEach(function (node) {
            var attributes = node._zipperLocalizedAttributes || {};
            Object.keys(attributes).forEach(function (attribute) {
                var value = attributes[attribute];
                node.setAttribute(attribute, translate(value.key, value.fallback, value.values));
            });
        });
        document.querySelectorAll('[data-zipper-language-code]').forEach(function (node) {
            node.textContent = languageLabel(node.getAttribute('data-zipper-language-code'));
        });
        document.querySelectorAll('[data-zipper-i18n-render="true"]').forEach(function (node) {
            if (typeof node._zipperI18nRenderer === 'function') node._zipperI18nRenderer();
        });
        scheduleScan();
    }

    function setLocalizedRenderer(node, renderer) {
        node._zipperI18nRenderer = renderer;
        node.setAttribute('data-zipper-i18n-render', 'true');
        renderer();
        return node;
    }

    function contextFor(item) {
        var current = identity();
        if (!item || !current.client || !current.serverId || !current.userId) return null;
        if (!UUID_PATTERN.test(item.id || '') || !SUPPORTED_TYPES[item.type]) return null;
        if (!sameGuid(item.serverId, current.serverId)) return null;
        return {
            itemId: item.id,
            itemType: item.type,
            title: item.title || '',
            serverId: current.serverId,
            identityKey: current.key,
            routeKey: getRouteKey()
        };
    }

    function isContextCurrent(context) {
        if (!context) return false;
        var current = identity();
        return current.client && current.userId && current.serverId
            && current.key === context.identityKey
            && getRouteKey() === context.routeKey
            && sameGuid(current.serverId, context.serverId);
    }

    function normalizeGuid(value) {
        var text = String(value || '');
        return UUID_PATTERN.test(text) ? text.replace(/-/g, '').toLowerCase() : '';
    }

    function sameGuid(left, right) {
        var a = normalizeGuid(left);
        return !!a && a === normalizeGuid(right);
    }

    function sessionContext() {
        var current = identity();
        if (!current.client || !current.userId || !current.serverId) return null;
        return { itemId: null, itemType: null, title: '', serverId: current.serverId, identityKey: current.key, routeKey: getRouteKey() };
    }

    function request(client, path, method, body) {
        if (!client || typeof client.ajax !== 'function' || typeof client.getUrl !== 'function') {
            return Promise.reject(new Error('The active Jellyfin API client is unavailable.'));
        }
        var options = {
            url: client.getUrl('Zipper/' + path),
            type: method,
            dataType: 'json'
        };
        if (body !== undefined) {
            options.data = JSON.stringify(body);
            options.contentType = 'application/json';
        }
        return client.ajax(options);
    }

    function statusOf(error) {
        if (!error || typeof error !== 'object') return 0;
        return Number(error.status || (error.response && error.response.status) || 0);
    }

    function errorMessage(error, fallback) {
        var code = '';
        var dto = error && (error.responseJSON || error.data || error.response && error.response.data);
        if (dto && typeof dto.code === 'string') code = dto.code;
        if (!code && error && typeof error.responseText === 'string') {
            try {
                var parsed = JSON.parse(error.responseText);
                if (parsed && typeof parsed.code === 'string') code = parsed.code;
            } catch (_) { }
        }
        var known = Object.prototype.hasOwnProperty.call(API_ERROR_TEXT, code) ? API_ERROR_TEXT[code] : null;
        var safeFallback = fallback && fallback.zipperLocalized === true
            ? translate(fallback.key, fallback.fallback, fallback.values) : fallback;
        return Promise.resolve(known ? translate(known.key, known.fallback) : safeFallback);
    }

    function handleAuthorizationFailure(error) {
        var status = statusOf(error);
        if (status === 401 || status === 403) {
            state.jobPollingUnavailableFor = identity().key;
            state.caps = null;
            removeOwnedActions();
            closeModal();
            state.pendingContext = null;
        }
    }

    function ensureCapabilities(force) {
        var current = identity();
        if (!current.client || !current.userId || !current.serverId) {
            state.caps = null;
            state.capIdentity = current.key;
            state.capPending = false;
            removeOwnedActions();
            return Promise.resolve(null);
        }
        if (force) {
            state.capUnavailable = false;
            state.capRetryAfter = 0;
        }
        if (!force && state.capUnavailable) return Promise.resolve(null);
        if (!force && state.capIdentity === current.key && state.caps) return Promise.resolve(state.caps);
        if (!force && state.capIdentity === current.key && state.capPending) return Promise.resolve(null);

        state.capIdentity = current.key;
        state.caps = null;
        var requestId = ++state.capRequest;
        state.capPending = true;
        removeOwnedActions();
        return request(current.client, 'Capabilities', 'GET').then(function (result) {
            if (requestId !== state.capRequest || identity().key !== current.key) return null;
            state.caps = result && result.enabled === true && result.uiEnabled === true ? result : null;
            state.capPending = false;
            if (!state.caps) {
                closeModal();
                removeOwnedActions();
                if (result && (result.enabled === false || result.uiEnabled === false)) {
                    state.capUnavailable = true;
                    detachUiHooks();
                } else {
                    state.capRetryAfter = Date.now() + 10000;
                }
            } else {
                scheduleScan();
            }
            return state.caps;
        }).catch(function (error) {
            if (requestId === state.capRequest && identity().key === current.key) {
                state.capPending = false;
                state.caps = null;
                state.capRetryAfter = Date.now() + 10000;
                handleAuthorizationFailure(error);
                removeOwnedActions();
            }
            return null;
        });
    }

    function scopeEnabled(type) {
        if (!state.caps || !SUPPORTED_TYPES[type]) return false;
        var scopes = Array.isArray(state.caps.scopes) ? state.caps.scopes : [];
        return scopes.some(function (scope) {
            return scope && String(scope.itemType).toLowerCase() === type && scope.enabled === true;
        });
    }

    function makeElement(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text && text.zipperLocalized === true) applyLocalizedText(node, text);
        else if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function makeButton(text, className, icon, label) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = className || 'emby-button';
        if (label && label.zipperLocalized === true) applyLocalizedAttribute(button, 'aria-label', label);
        else button.setAttribute('aria-label', label || (text && text.zipperLocalized ? translate(text.key, text.fallback, text.values) : text));
        if (icon) {
            var iconNode = makeElement('span', 'material-icons ' + icon, '');
            iconNode.setAttribute('aria-hidden', 'true');
            button.appendChild(iconNode);
        }
        if (text) button.appendChild(makeElement('span', 'zipper-button-label', text));
        return button;
    }

    function makeLabeledInput(labelText, input, className) {
        var label = makeElement('label', className || 'zipper-field');
        label.appendChild(input);
        if (labelText && typeof labelText === 'object' && labelText.nodeType === 1) label.appendChild(labelText);
        else label.appendChild(makeElement('span', 'zipper-field-label', labelText));
        return label;
    }

    function languageLabelNode(language, className) {
        var node = makeElement('span', className || 'zipper-language-label', languageLabel(language));
        node.setAttribute('data-zipper-language-code', String(language || ''));
        return node;
    }

    function visible(node) {
        if (!node || !node.isConnected) return false;
        for (var current = node; current && current !== document.documentElement; current = current.parentElement) {
            if (current.hidden || current.classList.contains('hide')) return false;
            var style;
            try { style = window.getComputedStyle(current); } catch (_) { style = null; }
            if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) return false;
        }
        var rects = node.getClientRects();
        return !!rects.length && Array.prototype.some.call(rects, function (rect) { return rect.width > 0 && rect.height > 0; });
    }

    function typeName(value) {
        var labels = { movie: 'Movie', episode: 'Episode', season: 'Season', series: 'Series' };
        return translate('type.' + value, labels[value] || 'Media');
    }

    function normalizedType(raw) {
        var type = String(raw || '').toLowerCase();
        return SUPPORTED_TYPES[type] ? type : '';
    }

    function itemFromElement(element) {
        if (!element) return null;
        var direct = element.closest('[data-id][data-type][data-serverid]');
        if (direct && !direct.closest('.zipper-overlay')) {
            return {
                id: direct.getAttribute('data-id'),
                type: normalizedType(direct.getAttribute('data-type')),
                serverId: direct.getAttribute('data-serverid'),
                title: direct.getAttribute('aria-label') || (direct.querySelector('.cardText, .listItemBodyText') || {}).textContent || ''
            };
        }
        var card = element.closest('.card[data-id][data-type][data-serverid], .listItem[data-id][data-type][data-serverid]');
        if (card && !card.closest('.zipper-overlay')) {
            return {
                id: card.getAttribute('data-id'),
                type: normalizedType(card.getAttribute('data-type')),
                serverId: card.getAttribute('data-serverid'),
                title: card.getAttribute('aria-label') || (card.querySelector('.cardText, .listItemBodyText') || {}).textContent || ''
            };
        }
        var detail = element.closest('.page.itemDetailPage');
        if (detail && visible(detail)) return itemFromDetail(detail);
        return null;
    }

    function itemFromDetail(page) {
        if (!page || !visible(page)) return null;
        var identityNode = page.querySelector('.btnPlaystate[data-id][data-type][data-serverid]');
        if (!identityNode) return null;
        var rating = page.querySelector('.btnUserRating[data-id][data-serverid]');
        if (rating && (!sameGuid(rating.getAttribute('data-id'), identityNode.getAttribute('data-id'))
            || !sameGuid(rating.getAttribute('data-serverid'), identityNode.getAttribute('data-serverid')))) return null;
        return {
            id: identityNode.getAttribute('data-id'),
            type: normalizedType(identityNode.getAttribute('data-type')),
            serverId: identityNode.getAttribute('data-serverid'),
            title: (page.querySelector('.nameContainer') || {}).textContent || ''
        };
    }

    function detailItem(page) {
        var item = itemFromDetail(page);
        if (!item || !item.type || !item.id || !item.serverId) return null;
        var playButton = page.querySelector('.btnPlay[data-id][data-serverid][data-type]');
        var ratingButton = page.querySelector('.btnUserRating[data-id][data-serverid]');
        if (playButton && (!sameGuid(playButton.getAttribute('data-id'), item.id)
            || !sameGuid(playButton.getAttribute('data-serverid'), item.serverId))) return null;
        if (ratingButton && (!sameGuid(ratingButton.getAttribute('data-id'), item.id)
            || !sameGuid(ratingButton.getAttribute('data-serverid'), item.serverId))) return null;
        return item;
    }

    function removeOwnedActions() {
        document.querySelectorAll('[data-zipper-owned="action"], [data-zipper-owned="menu"], [data-zipper-owned="launcher"]').forEach(function (node) {
            node.remove();
        });
    }

    function buildHeaderLauncher(toolbar) {
        if (!toolbar || toolbar.querySelector('[data-zipper-owned="launcher"]')) return;
        var launcher = makeButton('', 'paper-icon-button-light zipper-header-action', 'archive', localized('action.openCenter', 'Open Zipper download center'));
        launcher.setAttribute('data-zipper-owned', 'launcher');
        applyLocalizedAttribute(launcher, 'title', localized('action.centerTitle', 'Zipper downloads'));
        launcher.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            var context = sessionContext();
            if (context) openCenter(context, null);
        });
        toolbar.appendChild(launcher);
    }

    function addActionSheetItem(sheet) {
        var pending = state.pendingContext;
        if (pending && !sheet.hasAttribute('data-zipper-sheet-watched')) {
            sheet.setAttribute('data-zipper-sheet-watched', 'true');
            sheet.addEventListener('close', function () {
                if (state.pendingContext === pending) state.pendingContext = null;
                sheet.removeAttribute('data-zipper-sheet-watched');
            }, { once: true });
        }
        if (!pending || pending.consumed || pending.ambiguous || Date.now() - pending.capturedAt > 12000 || !isContextCurrent(pending.context)) return;
        if (!scopeEnabled(pending.context.itemType)) return;
        var scroller = sheet.querySelector('.actionSheetScroller');
        var nativeDownload = scroller && (scroller.querySelector('.actionSheetMenuItem[data-id="downloadall"]')
            || scroller.querySelector('.actionSheetMenuItem[data-id="download"]'));
        if (!scroller || !nativeDownload || scroller.querySelector('[data-zipper-owned="menu"]')) return;

        var buttonClasses = ['listItem', 'listItem-button', 'actionSheetMenuItem', 'zipper-menu-action'];
        if (nativeDownload.classList.contains('listItem-border')) buttonClasses.push('listItem-border');
        if (nativeDownload.classList.contains('listItem-focusscale')) buttonClasses.push('listItem-focusscale');
        if (nativeDownload.classList.contains('actionsheet-xlargeFont')) buttonClasses.push('actionsheet-xlargeFont');

        var button = document.createElement('button');
        button.type = 'button';
        button.className = buttonClasses.join(' ');
        button.setAttribute('is', 'emby-button');
        button.setAttribute('data-id', 'zipper-download');
        button.setAttribute('data-zipper-owned', 'menu');
        applyLocalizedAttribute(button, 'aria-label', localized('action.downloadZipFor', 'Download ZIP for {title}', { title: pending.context.title || typeName(pending.context.itemType) }));

        var icon = makeElement('span', 'actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons file_download', '');
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);

        var body = makeElement('div', 'listItemBody actionsheetListItemBody');
        var textNode = makeElement('div', 'listItemBodyText actionSheetItemText', localized('action.downloadZip', 'Download ZIP'));
        body.appendChild(textNode);
        button.appendChild(body);

        sheet.setAttribute('data-zipper-context-bound', 'true');
        state.pendingContext = null;
        button.addEventListener('click', function () {
            if (pending.consumed) return;
            pending.consumed = true;
            var captured = pending.context;
            sheet.addEventListener('close', function () {
                window.requestAnimationFrame(function () {
                    if (isContextCurrent(captured) && scopeEnabled(captured.itemType)) openChooser(captured);
                });
            }, { once: true });
        });
        nativeDownload.parentNode.insertBefore(button, nativeDownload.nextSibling);
    }

    function scanRelevantDom() {
        if (!state.caps || identity().key !== state.capIdentity) {
            removeOwnedActions();
            return;
        }
        var details = document.querySelectorAll('.page.itemDetailPage');
        Array.prototype.forEach.call(details, function (page) {
            var previous = page.querySelector('[data-zipper-owned="action"]');
            if (previous) previous.remove();
        });

        var headers = document.querySelectorAll('header .MuiToolbar-root');
        var visibleToolbar = Array.prototype.find.call(headers, visible);
        if (visibleToolbar) buildHeaderLauncher(visibleToolbar);
        else document.querySelectorAll('[data-zipper-owned="launcher"]').forEach(function (launcher) { launcher.remove(); });

        var sheets = Array.prototype.filter.call(document.querySelectorAll('.actionSheet.opened'), visible);
        if (sheets.length === 1) addActionSheetItem(sheets[0]);
    }

    function scheduleScan() {
        if (state.scanFrame) return;
        state.scanFrame = window.requestAnimationFrame(function () {
            state.scanFrame = 0;
            scanRelevantDom();
        });
    }

    function storePendingContext(element) {
        var item = itemFromElement(element);
        var context = contextFor(item);
        if (!context || !scopeEnabled(context.itemType)) {
            state.pendingContext = null;
            return;
        }
        var now = Date.now();
        if (now < state.ambiguousContextUntil) return;
        if (state.pendingContext && !state.pendingContext.consumed && now - state.pendingContext.capturedAt <= 12000) {
            if (sameGuid(state.pendingContext.context.itemId, context.itemId)
                && state.pendingContext.context.itemType === context.itemType
                && state.pendingContext.context.identityKey === context.identityKey
                && state.pendingContext.context.routeKey === context.routeKey) {
                state.pendingContext.capturedAt = now;
                return;
            }
            state.pendingContext = null;
            state.ambiguousContextUntil = now + 12000;
            return;
        }
        state.pendingContext = { context: context, capturedAt: Date.now(), consumed: false };
        window.setTimeout(function () {
            if (state.pendingContext && Date.now() - state.pendingContext.capturedAt > 12000) state.pendingContext = null;
        }, 12100);
    }

    function onCaptureClick(event) {
        var target = event.target && event.target.closest ? event.target.closest('button, a, [role="button"]') : null;
        if (!target || target.closest('.zipper-overlay')) return;
        if (target.closest('.actionSheetMenuItem') && !target.closest('[data-zipper-owned="menu"]')) {
            state.pendingContext = null;
            return;
        }
        if (target.matches('.btnMoreCommands, .btnCardOptions, .itemAction[data-action="menu"], [data-action="menu"]')) {
            storePendingContext(target);
        }
    }

    function onContextMenu(event) {
        var card = event.target && event.target.closest ? event.target.closest('.card[data-id][data-type][data-serverid], .listItem[data-id][data-type][data-serverid]') : null;
        if (card) storePendingContext(card);
    }

    function onRouteChange() {
        var next = getRouteKey();
        if (next === state.routeKey) return;
        state.routeKey = next;
        state.pendingContext = null;
        closeModal();
        scheduleScan();
    }

    function watchDom() {
        if (!document.documentElement || state.observer) return;
        state.observer = new MutationObserver(function (records) {
            var relevant = records.some(isRelevantMutation);
            if (relevant) scheduleScan();
        });
        state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    }

    function isOwnedNode(node) {
        if (!node || node.nodeType !== 1) return false;
        return node.closest('[data-zipper-owned]') !== null;
    }

    function containsRelevantNode(node) {
        if (!node || node.nodeType !== 1 || isOwnedNode(node)) return false;
        if (node.matches('.page.itemDetailPage, .actionSheet, header .MuiToolbar-root')) return true;
        return !!node.querySelector('.page.itemDetailPage, .actionSheet, header .MuiToolbar-root');
    }

    function isRelevantMutation(record) {
        var target = record.target && record.target.nodeType === 1 ? record.target : record.target && record.target.parentElement;
        if (target && (target.closest('.zipper-overlay') || isOwnedNode(target))) return false;
        if (record.type === 'attributes') return !!(target && target.closest('.btnDownload') && target.closest('.mainDetailButtons'));
        var changed = Array.prototype.slice.call(record.addedNodes).concat(Array.prototype.slice.call(record.removedNodes));
        if (!changed.length || changed.every(isOwnedNode)) return false;
        if (target && (target.matches('.page.itemDetailPage, .actionSheet, header .MuiToolbar-root')
            || target.closest('.page.itemDetailPage, .actionSheet, header .MuiToolbar-root'))) return true;
        return changed.some(containsRelevantNode);
    }

    function attachUiHooks() {
        if (state.started) return;
        state.started = true;
        document.addEventListener('click', onCaptureClick, true);
        document.addEventListener('contextmenu', onContextMenu, true);
        window.addEventListener('hashchange', onRouteChange);
        window.addEventListener('popstate', onRouteChange);
        document.addEventListener('visibilitychange', onVisibilityChange);
        watchDom();
    }

    function detachUiHooks() {
        if (!state.started) return;
        document.removeEventListener('click', onCaptureClick, true);
        document.removeEventListener('contextmenu', onContextMenu, true);
        window.removeEventListener('hashchange', onRouteChange);
        window.removeEventListener('popstate', onRouteChange);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        if (state.observer) {
            state.observer.disconnect();
            state.observer = null;
        }
        if (state.scanFrame) {
            window.cancelAnimationFrame(state.scanFrame);
            state.scanFrame = 0;
        }
        state.pendingContext = null;
        state.started = false;
        if (state.pollTimer) {
            window.clearInterval(state.pollTimer);
            state.pollTimer = 0;
        }
        closeModal();
        removeOwnedActions();
    }

    function wake() {
        if (!state.localeObserver && typeof translations.observe === 'function') {
            state.localeObserver = translations.observe(relocalizeOwnedText);
        }
        var localeLoad = Promise.resolve().then(function () { return translations.load(); }).catch(function () { return translations; });
        state.localePromise = localeLoad;
        state.localePromise.then(function () {
            if (state.localePromise !== localeLoad) return;
            state.localePromise = null;
            if (!state.identityTimer) state.identityTimer = window.setInterval(checkIdentityAndRoute, 1200);
            if (!state.capUnavailable) attachUiHooks();
            checkIdentityAndRoute();
        });
    }

    function checkIdentityAndRoute() {
        onRouteChange();
        var current = identity();
        if (current.key !== state.identityKey) {
            clearDownloadRecords();
            state.jobRequest += 1;
            state.jobLoading = false;
            state.jobPollingUnavailableFor = '';
            state.identityKey = current.key;
            state.capIdentity = '';
            state.caps = null;
            state.capPending = false;
            state.capUnavailable = false;
            state.capRetryAfter = 0;
            state.pendingContext = null;
            closeModal();
            removeOwnedActions();
            attachUiHooks();
            if (current.client && current.userId && current.serverId) ensureCapabilities(true);
            else ensureCapabilities(false);
            return;
        }
        if (current.client && current.userId && current.serverId && !state.caps && !state.capPending
            && !state.capUnavailable && Date.now() >= state.capRetryAfter) ensureCapabilities(true);
    }

    function clearDownloadRecords() {
        if (state.pollTimer) {
            window.clearInterval(state.pollTimer);
            state.pollTimer = 0;
        }
        state.downloads.forEach(function (record) {
            if (record.cleanupTimer) window.clearTimeout(record.cleanupTimer);
            if (record.frame && record.frame.isConnected) record.frame.remove();
        });
        state.downloads.clear();
    }

    function dispose() {
        clearDownloadRecords();
        detachUiHooks();
        if (state.identityTimer) {
            window.clearInterval(state.identityTimer);
            state.identityTimer = 0;
        }
        if (state.pollTimer) {
            window.clearInterval(state.pollTimer);
            state.pollTimer = 0;
        }
        state.capRequest += 1;
        state.capPending = false;
        state.jobRequest += 1;
        state.jobLoading = false;
        if (state.localeObserver) {
            state.localeObserver();
            state.localeObserver = null;
        }
    }

    function onVisibilityChange() {
        if (document.visibilityState === 'visible') {
            scheduleScan();
            if (isCenterVisible()) refreshJobs();
        }
        updatePolling();
    }

    function createModal(context) {
        if (state.modal) closeModal();
        var previousFocus = document.activeElement;
        var overlay = makeElement('div', 'zipper-overlay');
        overlay.setAttribute('data-zipper-owned', 'modal');
        var dialog = makeElement('section', 'zipper-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'zipper-dialog-title');
        dialog.setAttribute('tabindex', '-1');
        var header = makeElement('header', 'zipper-dialog-header');
        var back = makeButton('', 'paper-icon-button-light zipper-dialog-back', 'arrow_back', localized('dialog.back', 'Go back'));
        back.hidden = true;
        var title = makeElement('h2', 'zipper-dialog-title', localized('dialog.title', 'Zipper'));
        title.id = 'zipper-dialog-title';
        var close = makeButton('', 'paper-icon-button-light zipper-dialog-close', 'close', localized('dialog.close', 'Close dialog'));
        header.appendChild(back);
        header.appendChild(title);
        header.appendChild(close);
        var body = makeElement('div', 'zipper-dialog-body');
        dialog.appendChild(header);
        dialog.appendChild(body);
        overlay.appendChild(dialog);
        var modal = { overlay: overlay, dialog: dialog, body: body, title: title, back: back, close: close, context: context, currentView: null, restoreFocus: previousFocus, viewNodes: {} };
        close.addEventListener('click', closeModal);
        back.addEventListener('click', function () {
            if (typeof modal.backAction === 'function') modal.backAction();
        });
        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) closeModal();
        });
        overlay.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeModal();
            } else if (event.key === 'Tab') {
                trapFocus(event, dialog);
            }
        }, true);
        document.body.appendChild(overlay);
        state.modal = modal;
        dialog.focus();
        return modal;
    }

    function trapFocus(event, container) {
        var selectors = 'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])';
        var candidates = Array.prototype.filter.call(container.querySelectorAll(selectors), visible);
        if (!candidates.length) {
            event.preventDefault();
            container.focus();
            return;
        }
        var first = candidates[0];
        var last = candidates[candidates.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function showScreen(modal, key, node, title, backAction) {
        if (!modal || modal !== state.modal) return;
        modal.currentView = key;
        if (title && title.zipperLocalized === true) applyLocalizedText(modal.title, title);
        else modal.title.textContent = title;
        modal.backAction = backAction || null;
        modal.back.hidden = !backAction;
        modal.body.replaceChildren(node);
        window.requestAnimationFrame(function () {
            if (modal === state.modal) {
                var first = modal.body.querySelector('button:not([disabled]), input:not([disabled]), select:not([disabled])');
                (first || modal.dialog).focus();
            }
        });
        updatePolling();
    }

    function restoreFocusMatchesContext(target, context) {
        var owned = target.getAttribute('data-zipper-owned');
        if (owned === 'launcher') return !context.itemId;
        if (!context.itemId) return false;
        if (owned === 'action') {
            return sameGuid(target.getAttribute('data-item-id'), context.itemId)
                && target.getAttribute('data-item-type') === context.itemType
                && sameGuid(target.getAttribute('data-server-id'), context.serverId);
        }
        if (target.matches('.btnMoreCommands, .btnCardOptions, .itemAction[data-action="menu"], [data-action="menu"]')) {
            var item = itemFromElement(target);
            return !!item && sameGuid(item.id, context.itemId) && item.type === context.itemType
                && sameGuid(item.serverId, context.serverId);
        }
        return false;
    }

    function resolveModalRestoreFocus(modal) {
        var context = modal && modal.context;
        if (!context || !isContextCurrent(context)) return null;

        var previousFocus = modal.restoreFocus;
        if (previousFocus && previousFocus !== document.body && previousFocus !== document.documentElement
            && previousFocus.isConnected && visible(previousFocus) && typeof previousFocus.focus === 'function'
            && restoreFocusMatchesContext(previousFocus, context)) return previousFocus;

        if (!context.itemId) {
            var launchers = document.querySelectorAll('header .MuiToolbar-root [data-zipper-owned="launcher"]');
            return Array.prototype.find.call(launchers, visible) || null;
        }

        if (!scopeEnabled(context.itemType)) return null;
        var pages = document.querySelectorAll('.page.itemDetailPage');
        for (var i = 0; i < pages.length; i++) {
            var page = pages[i];
            if (!visible(page)) continue;
            var item = detailItem(page);
            if (!item || !sameGuid(item.id, context.itemId) || item.type !== context.itemType
                || !sameGuid(item.serverId, context.serverId)) continue;
            var current = contextFor(item);
            if (!current || !isContextCurrent(current) || !scopeEnabled(current.itemType)) continue;
            var more = page.querySelector('.mainDetailButtons .btnMoreCommands, .mainDetailButtons [data-action="menu"]');
            if (more && visible(more)) return more;
        }
        return null;
    }

    function closeModal() {
        var modal = state.modal;
        if (!modal) return;
        state.modal = null;
        modal.overlay.remove();
        var restoreFocus = resolveModalRestoreFocus(modal);
        if (restoreFocus && typeof restoreFocus.focus === 'function') {
            try { restoreFocus.focus({ preventScroll: true }); } catch (_) { restoreFocus.focus(); }
        }
        updatePolling();
    }

    function openChooser(context) {
        if (!isContextCurrent(context) || !scopeEnabled(context.itemType)) return;
        var modal = createModal(context);
        var loading = makeElement('div', 'zipper-loading', localized('dialog.loading', 'Checking access, item details, and account preferences…'));
        loading.setAttribute('role', 'status');
        showScreen(modal, 'loading', loading, localized('dialog.loadingTitle', 'Download ZIP'), null);

        ensureCapabilities(true).then(function (caps) {
            if (!caps || !scopeEnabled(context.itemType) || !isContextCurrent(context)) throw new Error(translate('dialog.error.unavailable', 'Zipper is unavailable for this item or account.'));
            var client = identity().client;
            var catalogTask = request(client, 'Catalog/' + encodeURIComponent(context.itemId), 'GET');
            var preferenceTask = request(client, 'Preferences', 'GET').catch(function (error) {
                if (!isContextCurrent(context) || state.modal !== modal) throw error;
                handleAuthorizationFailure(error);
                if (statusOf(error) === 401 || statusOf(error) === 403) throw error;
                return { mode: 'mediaAndSubtitles', subtitleLanguages: [] };
            });
            return Promise.all([catalogTask, preferenceTask]);
        }).then(function (results) {
            if (state.modal !== modal || !isContextCurrent(context)) return;
            var catalog = results[0];
            var preferences = normalizePreferences(results[1]);
            if (!catalog || !sameGuid(catalog.itemId, context.itemId)
                || normalizedType(catalog.itemType) !== context.itemType || !scopeEnabled(context.itemType)) {
                throw new Error(translate('dialog.error.itemChanged', 'This item is no longer available for a Zipper download.'));
            }
            var chooser = buildChooser(modal, context, catalog, preferences);
        showScreen(modal, 'chooser', chooser.root, localized('dialog.loadingTitle', 'Download ZIP'), null);
            modal.chooser = chooser;
            modal.openCenter = function () { openCenter(context, function () { showChooser(modal); }); };
            modal.openPreferences = function () { openPreferences(modal, chooser.preferences, chooser.availableLanguages(), chooser.returnFromPreferences); };
            chooser.startPreview(chooser.discoveryNeeded);
        }).catch(function (error) {
            if (state.modal !== modal || !isContextCurrent(context)) return;
            handleAuthorizationFailure(error);
            if (state.modal !== modal) return;
            Promise.resolve(errorMessage(error, localized('dialog.error.load', 'Zipper could not load the item. Check that downloading is allowed for this account.'))).then(function (message) {
                if (state.modal === modal && isContextCurrent(context)) showErrorView(modal, localized('dialog.error.title', 'Could not load this item'), message);
            });
        });
    }

    function normalizePreferences(value) {
        var mode = value && MODES.some(function (entry) { return entry.value === value.mode; }) ? value.mode : 'mediaAndSubtitles';
        var languages = value && Array.isArray(value.subtitleLanguages) ? value.subtitleLanguages : [];
        return {
            mode: mode,
            subtitleLanguages: languages.filter(function (language) { return typeof language === 'string' && language.length <= 35; }).slice(0, 20)
        };
    }

    function showErrorView(modal, title, message) {
        var panel = makeElement('div', 'zipper-error-view');
        var text = makeElement('p', 'zipper-error-message', message);
        text.setAttribute('role', 'alert');
        var close = makeButton(localized('dialog.error.close', 'Close'), 'emby-button button-cancel zipper-secondary-button');
        close.addEventListener('click', closeModal);
        panel.appendChild(makeElement('h3', '', title && title.zipperLocalized ? title : String(title || '')));
        panel.appendChild(text);
        panel.appendChild(close);
        showScreen(modal, 'error', panel, localized('dialog.title', 'Zipper'), null);
    }

    function warningText(message) {
        var match = /^Only the first (\d+) archive file names are shown in this preview\.$/.exec(String(message || ''));
        if (match) return localized('warning.moreFileNames', 'Only the first {count} archive file names are shown in this preview.', { count: translations.number(Number(match[1])) });
        match = /^Only the first (\d+) associated subtitle tracks are shown here\.$/.exec(String(message || ''));
        if (match) return localized('warning.moreTrackNames', 'Only the first {count} associated subtitle tracks are shown here.', { count: translations.number(Number(match[1])) });
        return Object.prototype.hasOwnProperty.call(WARNING_TEXT, message) ? WARNING_TEXT[message] : localized('warning.unknown', 'Some package details need attention.');
    }

    function buildChooser(modal, context, catalog, preferences) {
        var root = makeElement('div', 'zipper-chooser');
        var summary = makeElement('div', 'zipper-summary');
        summary.appendChild(makeElement('h3', 'zipper-summary-title', catalog.title || context.title || localized('chooser.selectedItem', 'Selected item')));
        root.appendChild(summary);

        var status = makeElement('div', 'zipper-inline-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        root.appendChild(status);

        var warningBox = makeElement('div', 'zipper-warning-list');
        warningBox.setAttribute('aria-live', 'polite');
        root.appendChild(warningBox);
        renderWarnings(warningBox, catalog.warnings || []);

        var modeField = makeElement('fieldset', 'zipper-fieldset zipper-mode-field');
        modeField.appendChild(makeElement('legend', '', localized('chooser.packageContents', 'Package contents')));
        var modeInputs = [];
        MODES.forEach(function (mode, index) {
            var input = document.createElement('input');
            input.type = 'radio';
            input.name = 'zipper-mode-' + modal.context.itemId;
            input.value = mode.value;
            input.checked = mode.value === preferences.mode;
            input.id = 'zipper-mode-' + index + '-' + modal.context.itemId;
            var label = makeLabeledInput(localized('mode.' + mode.value, mode.label), input, 'zipper-option zipper-radio-option');
            modeField.appendChild(label);
            modeInputs.push(input);
        });
        root.appendChild(modeField);

        var sourceField = makeElement('fieldset', 'zipper-fieldset zipper-source-field');
        sourceField.appendChild(makeElement('legend', '', localized('chooser.mediaVersion', 'Media version')));
        var sourceSelect = document.createElement('select');
        sourceSelect.className = 'emby-select zipper-source-select';
        applyLocalizedAttribute(sourceSelect, 'aria-label', localized('chooser.mediaVersion', 'Media version'));
        var isBulkItem = context.itemType === 'season' || context.itemType === 'series';
        var mediaSources = !isBulkItem && Array.isArray(catalog.mediaSources) ? catalog.mediaSources.filter(function (source) {
            return source && typeof source.id === 'string' && UUID_PATTERN.test(source.id);
        }) : [];
        mediaSources.forEach(function (source) {
            var option = document.createElement('option');
            option.value = source.id;
            setLocalizedRenderer(option, function () {
                option.textContent = (source.isPrimary ? translate('chooser.primaryPrefix', 'Primary · ') : '') + (source.name || translate('chooser.mediaVersion', 'Media version')) + (source.container ? ' (' + source.container + ')' : '');
            });
            sourceSelect.appendChild(option);
        });
        var selectedSource = mediaSources.find(function (source) { return source.isPrimary; }) || mediaSources[0] || null;
        if (selectedSource) sourceSelect.value = selectedSource.id;
        if (mediaSources.length < 2) sourceField.hidden = true;
        sourceField.appendChild(sourceSelect);
        if (mediaSources.length > 1) sourceField.appendChild(makeElement('p', 'zipper-field-help', localized('chooser.versionHelp', 'The selected version supplies the original media and its associated subtitle tracks.')));
        root.appendChild(sourceField);

        var seriesState = {
            wholeSeries: false,
            selectedSeasons: new Set(),
            selectedSeasonIds: []
        };
        var seasons = Array.isArray(catalog.seasons) ? catalog.seasons.filter(function (season) {
            return season && typeof season.id === 'string' && UUID_PATTERN.test(season.id);
        }) : [];
        var seasonField = makeElement('fieldset', 'zipper-fieldset zipper-season-field');
        seasonField.appendChild(makeElement('legend', '', localized('chooser.seasons', 'Seasons')));
        var seasonRows = makeElement('div', 'zipper-season-list');
        var allSeasonsInput = document.createElement('input');
        allSeasonsInput.type = 'checkbox';
        allSeasonsInput.id = 'zipper-all-seasons-' + context.itemId;
        var allSeasonLabel = makeLabeledInput(localized('chooser.allSeasons', 'Include every available season as one whole-series package'), allSeasonsInput, 'zipper-option zipper-all-seasons');
        if (context.itemType === 'series') seasonField.appendChild(allSeasonLabel);
        if (context.itemType === 'series') {
            var regular = seasons.filter(function (season) { return season.seasonNumber !== null && season.seasonNumber !== undefined && Number(season.seasonNumber) > 0; })
                .sort(function (a, b) { return Number(a.seasonNumber) - Number(b.seasonNumber); });
            var defaultSeason = regular[0] || seasons[0];
            if (defaultSeason) seriesState.selectedSeasons.add(defaultSeason.id);
            seasons.forEach(function (season, index) {
                var input = document.createElement('input');
                input.type = 'checkbox';
                input.value = season.id;
                input.id = 'zipper-season-' + index + '-' + context.itemId;
                input.checked = seriesState.selectedSeasons.has(season.id);
                var detail = makeElement('span', 'zipper-field-label');
                setLocalizedRenderer(detail, function () {
                    var labelText = season.title || (season.seasonNumber === null || season.seasonNumber === undefined ? translate('chooser.specials', 'Specials') : translate('chooser.seasonNumber', 'Season {number}', { number: translations.number(season.seasonNumber) }));
                    if (season.episodeCount !== null && season.episodeCount !== undefined) labelText += ' · ' + translations.plural('chooser.episodes', Number(season.episodeCount), { one: '{count} episode', few: '{count} episodes', many: '{count} episodes', other: '{count} episodes' });
                    detail.textContent = labelText;
                });
                var label = makeLabeledInput(detail, input, 'zipper-option zipper-season-option');
                seasonRows.appendChild(label);
            });
            seasonField.appendChild(seasonRows);
            seasonField.appendChild(makeElement('p', 'zipper-field-help', localized('chooser.seriesHelp', 'A whole-series package may be large. The server applies its item, file, size, and concurrency limits. Select one or more seasons for a smaller package.')));
            root.appendChild(seasonField);
        } else if (context.itemType === 'season') {
            var season = seasons[0];
            var seasonHelp = makeElement('p', 'zipper-field-help');
            setLocalizedRenderer(seasonHelp, function () {
                seasonHelp.textContent = season
                    ? (season.title || (season.seasonNumber === null || season.seasonNumber === undefined ? translate('chooser.specials', 'Specials') : translate('chooser.seasonNumber', 'Season {number}', { number: translations.number(season.seasonNumber) })))
                        + (season.episodeCount === null || season.episodeCount === undefined ? '' : ' · ' + translations.plural('chooser.episodes', Number(season.episodeCount), { one: '{count} episode', few: '{count} episodes', many: '{count} episodes', other: '{count} episodes' }))
                    : translate('chooser.allEpisodes', 'All episodes in this season will be included.');
            });
            seasonField.appendChild(seasonHelp);
            seasonField.hidden = false;
            root.appendChild(seasonField);
        }

        var tracksField = makeElement('fieldset', 'zipper-fieldset zipper-track-field');
        tracksField.appendChild(makeElement('legend', '', localized('chooser.subtitleTracks', 'Subtitle tracks')));
        var tracksHelp = makeElement('p', 'zipper-field-help', context.itemType === 'season' || context.itemType === 'series'
            ? localized('chooser.bulkTracksHelp', 'The track list is discovered from the selected episodes. Every supported associated external track is included by default.')
            : localized('chooser.singleTracksHelp', 'Every supported external track associated with this media source is selected by default.'));
        tracksField.appendChild(tracksHelp);
        var languageSlot = makeElement('div', 'zipper-language-slot');
        var trackRows = makeElement('div', 'zipper-track-list');
        tracksField.appendChild(languageSlot);
        tracksField.appendChild(trackRows);
        root.appendChild(tracksField);

        var previewSection = makeElement('section', 'zipper-preview-section');
        applyLocalizedAttribute(previewSection, 'aria-label', localized('chooser.previewLabel', 'Package preview'));
        var previewHeading = makeElement('div', 'zipper-preview-heading');
        previewHeading.appendChild(makeElement('h4', '', localized('chooser.previewTitle', 'Package preview')));
        var previewSummary = makeElement('span', 'zipper-preview-summary', localized('chooser.checkingFiles', 'Checking selected files…'));
        previewHeading.appendChild(previewSummary);
        previewSection.appendChild(previewHeading);
        var previewWarnings = makeElement('div', 'zipper-preview-warnings');
        previewSection.appendChild(previewWarnings);
        var fileList = makeElement('ul', 'zipper-file-list');
        previewSection.appendChild(fileList);
        root.appendChild(previewSection);

        var actions = makeElement('div', 'zipper-dialog-actions');
        var preferencesButton = makeButton(localized('chooser.preferences', 'Preferences'), 'emby-button button-flat zipper-secondary-button', 'tune', localized('chooser.preferencesAria', 'Edit account package preferences'));
        var centerButton = makeButton(localized('chooser.downloadCenter', 'Downloads'), 'emby-button button-flat zipper-secondary-button', 'history', localized('chooser.downloadCenterAria', 'Open download center'));
        var downloadButton = makeButton(localized('action.downloadZip', 'Download ZIP'), 'emby-button raised zipper-primary-button', 'file_download', localized('chooser.downloadAria', 'Create and download this ZIP package'));
        downloadButton.disabled = true;
        actions.appendChild(preferencesButton);
        actions.appendChild(centerButton);
        actions.appendChild(downloadButton);
        root.appendChild(actions);

        var chooser = {
            root: root,
            modal: modal,
            context: context,
            catalog: catalog,
            preferences: preferences,
            mediaSources: mediaSources,
            selectedSource: selectedSource,
            sourceSelect: sourceSelect,
            modeInputs: modeInputs,
            seasonRows: seasonRows,
            seasonField: seasonField,
            allSeasonsInput: allSeasonsInput,
            seriesState: seriesState,
            seasons: seasons,
            selectedIndices: null,
            selectedBulkLanguages: null,
            allBulkLanguages: true,
            knownLanguages: [],
            languageInputs: [],
            trackInputs: [],
            discoveryNeeded: context.itemType === 'season' || context.itemType === 'series',
            preferenceWarning: '',
            userTouchedLanguages: false,
            revision: 0,
            previewRevision: -1,
            submittedRevision: -1,
            preview: null,
            previewTimer: 0,
            pending: false,
            status: status,
            warningBox: warningBox,
            tracksField: tracksField,
            languageSlot: languageSlot,
            trackRows: trackRows,
            previewSummary: previewSummary,
            previewWarnings: previewWarnings,
            fileList: fileList,
            downloadButton: downloadButton,
            modeField: modeField,
            sourceField: sourceField,
            preferencesButton: preferencesButton,
            centerButton: centerButton,
            availableLanguages: function () {
                if (context.itemType === 'movie' || context.itemType === 'episode') {
                    return languagesFromTracks(currentTrackList(chooser));
                }
                return chooser.knownLanguages.slice();
            },
            startPreview: function (discover) { schedulePreview(chooser, discover); }
        };
        chooser.returnFromPreferences = function (updated) {
            if (modal !== state.modal || !isContextCurrent(context)) return;
            if (updated !== undefined) {
                updated = normalizePreferences(updated);
                chooser.preferences = updated;
                preferences = updated;
                chooser.selectedIndices = preferredTrackIndices(chooser.selectedSource ? chooser.selectedSource.subtitleTracks : [], updated.subtitleLanguages);
                renderTrackControls(chooser);
                chooser.modeInputs.forEach(function (input) { input.checked = input.value === updated.mode; });
                chooser.userTouchedLanguages = false;
                chooser.selectedBulkLanguages = null;
                chooser.allBulkLanguages = true;
                chooser.discoveryNeeded = context.itemType === 'season' || context.itemType === 'series';
                renderLanguageControls(chooser);
                invalidateChooser(chooser, chooser.discoveryNeeded);
            }
            showChooser(modal);
        };

        if (context.itemType === 'series') {
            allSeasonsInput.addEventListener('change', function () {
                chooser.seriesState.wholeSeries = allSeasonsInput.checked;
                seasonRows.querySelectorAll('input[type="checkbox"]').forEach(function (input) { input.disabled = allSeasonsInput.checked; });
                invalidateChooser(chooser, true);
            });
            seasonRows.addEventListener('change', function (event) {
                if (!event.target || event.target.type !== 'checkbox') return;
                chooser.seriesState.selectedSeasons = new Set(Array.prototype.map.call(seasonRows.querySelectorAll('input[type="checkbox"]:checked'), function (input) { return input.value; }));
                invalidateChooser(chooser, true);
            });
        }

        modeField.addEventListener('change', function () {
            if (modeField.querySelector('input[value="mediaAndSubtitles"]:checked, input[value="subtitlesOnly"]:checked')) {
                if ((context.itemType === 'series' || context.itemType === 'season') && !chooser.knownLanguages.length) chooser.discoveryNeeded = true;
            }
            invalidateChooser(chooser, chooser.discoveryNeeded);
        });
        sourceSelect.addEventListener('change', function () {
            chooser.selectedSource = mediaSources.find(function (source) { return source.id === sourceSelect.value; }) || null;
            chooser.selectedIndices = preferredTrackIndices(chooser.selectedSource ? chooser.selectedSource.subtitleTracks : [], preferences.subtitleLanguages);
            chooser.preferenceWarning = preferences.subtitleLanguages.length && !hasPreferenceTrackMatch(chooser.selectedSource ? chooser.selectedSource.subtitleTracks : [], preferences.subtitleLanguages)
                ? localized('warning.preferenceMissingSource', 'Saved subtitle languages are not listed for this media version. All supported associated tracks remain selected by default.') : '';
            renderChooserWarnings(chooser);
            renderTrackControls(chooser);
            invalidateChooser(chooser, false);
        });
        languageSlot.addEventListener('change', function (event) {
            if (!event.target || event.target.type !== 'checkbox') return;
            chooser.userTouchedLanguages = true;
            if (event.target.dataset.zipperAllLanguages === 'true') {
                chooser.allBulkLanguages = event.target.checked;
                chooser.selectedBulkLanguages = chooser.allBulkLanguages ? null : [];
                languageSlot.querySelectorAll('[data-zipper-language-value]').forEach(function (input) {
                    input.disabled = chooser.allBulkLanguages;
                    input.checked = false;
                });
            } else if (event.target.hasAttribute('data-zipper-language-value')) {
                chooser.allBulkLanguages = false;
                var allInput = languageSlot.querySelector('[data-zipper-all-languages="true"]');
                if (allInput) allInput.checked = false;
                chooser.selectedBulkLanguages = Array.prototype.map.call(languageSlot.querySelectorAll('[data-zipper-language-value]:checked'), function (input) { return input.value; });
            }
            invalidateChooser(chooser, false);
        });
        trackRows.addEventListener('change', function (event) {
            if (!event.target || !event.target.hasAttribute('data-zipper-track-index')) return;
            chooser.selectedIndices = Array.prototype.map.call(trackRows.querySelectorAll('[data-zipper-track-index]:checked'), function (input) { return Number(input.value); });
            invalidateChooser(chooser, false);
        });
        preferencesButton.addEventListener('click', function () {
            openPreferences(modal, chooser.preferences, chooser.availableLanguages(), chooser.returnFromPreferences);
        });
        centerButton.addEventListener('click', function () {
            openCenter(context, function () { showChooser(modal); });
        });
        downloadButton.addEventListener('click', function () { submitPackage(chooser); });

        chooser.selectedIndices = preferredTrackIndices(selectedSource ? selectedSource.subtitleTracks : [], preferences.subtitleLanguages);
        if (preferences.subtitleLanguages.length && (context.itemType === 'movie' || context.itemType === 'episode')
            && !hasPreferenceTrackMatch(selectedSource ? selectedSource.subtitleTracks : [], preferences.subtitleLanguages)) {
            chooser.preferenceWarning = localized('warning.preferenceMissingSource', 'Saved subtitle languages are not listed for this media version. All supported associated tracks remain selected by default.');
            renderChooserWarnings(chooser);
        }
        renderTrackControls(chooser);
        renderLanguageControls(chooser);
        updateChooserControls(chooser);
        return chooser;
    }

    function preferredTrackIndices(tracks, languages) {
        if (!Array.isArray(languages) || !languages.length) return null;
        var wanted = new Set(languages.map(function (language) { return String(language).toLowerCase(); }));
        var matches = (tracks || []).filter(function (track) {
            return track && track.language && wanted.has(String(track.language).toLowerCase());
        }).map(function (track) { return Number(track.index); }).filter(Number.isFinite);
        return matches.length ? matches : null;
    }

    function hasPreferenceTrackMatch(tracks, languages) {
        if (!Array.isArray(languages) || !languages.length) return true;
        var wanted = new Set(languages.map(function (language) { return String(language).toLowerCase(); }));
        return (tracks || []).some(function (track) { return track && track.language && wanted.has(String(track.language).toLowerCase()); });
    }

    function renderChooserWarnings(chooser) {
        renderWarnings(chooser.warningBox, chooser.catalog.warnings || []);
        if (chooser.preferenceWarning) chooser.warningBox.appendChild(makeElement('p', 'zipper-warning', chooser.preferenceWarning));
    }

    function modeOf(chooser) {
        var input = chooser.modeInputs.find(function (entry) { return entry.checked; });
        return input ? input.value : 'mediaAndSubtitles';
    }

    function currentTrackList(chooser) {
        if (chooser.context.itemType === 'movie' || chooser.context.itemType === 'episode') {
            return chooser.selectedSource && Array.isArray(chooser.selectedSource.subtitleTracks) ? chooser.selectedSource.subtitleTracks : [];
        }
        return [];
    }

    function renderTrackControls(chooser) {
        chooser.trackRows.replaceChildren();
        chooser.trackInputs = [];
        var tracks = currentTrackList(chooser);
        if (chooser.context.itemType === 'movie' || chooser.context.itemType === 'episode') {
            if (!tracks.length) {
                chooser.trackRows.appendChild(makeElement('p', 'zipper-empty-note', localized('chooser.noTracks', 'No supported associated external subtitle tracks are listed for this media version.')));
                return;
            }
            tracks.forEach(function (track, index) {
                var input = document.createElement('input');
                input.type = 'checkbox';
                input.value = String(track.index);
                input.id = 'zipper-track-' + index + '-' + chooser.context.itemId;
                input.setAttribute('data-zipper-track-index', 'true');
                input.checked = chooser.selectedIndices === null || chooser.selectedIndices.indexOf(Number(track.index)) !== -1;
                var hasTitle = typeof track.title === 'string' && track.title.length > 0;
                var sameAsLanguage = hasTitle && track.language && track.title.toLowerCase() === String(track.language).toLowerCase();
                var title = hasTitle ? track.title : track.language
                    ? languageLabelNode(track.language, 'zipper-field-label zipper-language-label')
                    : localized('track.number', 'Subtitle track {number}', { number: translations.number(Number(track.index) + 1) });
                var label = makeLabeledInput(title, input, 'zipper-option zipper-track-option');
                var details = [];
                if (track.language && hasTitle && !sameAsLanguage) details.push(languageLabelNode(track.language));
                if (track.codec) details.push(String(track.codec).toUpperCase());
                if (track.isForced) details.push(localized('track.forced', 'Forced'));
                if (track.isHearingImpaired) details.push(localized('track.hearingImpaired', 'Hearing impaired'));
                if (details.length) {
                    var meta = makeElement('span', 'zipper-track-meta');
                    details.forEach(function (detail, detailIndex) {
                        if (detailIndex) meta.appendChild(document.createTextNode(' · '));
                        if (detail && detail.zipperLocalized === true) meta.appendChild(makeElement('span', '', detail));
                        else meta.appendChild(detail && detail.nodeType === 1 ? detail : document.createTextNode(String(detail)));
                    });
                    label.appendChild(meta);
                }
                chooser.trackRows.appendChild(label);
                chooser.trackInputs.push(input);
            });
            return;
        }
    }

    function languageLabel(value) {
        var language = String(value || '').trim();
        if (!language || language.toLowerCase() === 'und') return translate('language.unknown', 'Unknown language');
        try {
            if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
                var names = new Intl.DisplayNames([translations.locale()], { type: 'language' });
                var displayName = names.of(language);
                if (displayName && displayName.toLowerCase() !== 'und') return displayName;
            }
        } catch (_) { }
        return language;
    }

    function languagesFromTracks(tracks) {
        var map = new Map();
        (tracks || []).forEach(function (track) {
            if (!track || typeof track.language !== 'string') return;
            var language = track.language.trim();
            if (!language) return;
            var key = language.toLowerCase();
            if (!map.has(key)) map.set(key, language);
        });
        return Array.from(map.values()).sort(function (a, b) { return languageLabel(a).localeCompare(languageLabel(b), translations.locale(), { sensitivity: 'base' }); });
    }

    function renderLanguageControls(chooser) {
        chooser.languageSlot.replaceChildren();
        chooser.languageInputs = [];
        if (chooser.context.itemType !== 'series' && chooser.context.itemType !== 'season') return;
        if (!chooser.knownLanguages.length) {
            chooser.languageSlot.appendChild(makeElement('p', 'zipper-empty-note', localized('chooser.languageOptionsAfterPreview', 'Language options appear after the first package preview.')));
            return;
        }
        var all = document.createElement('input');
        all.type = 'checkbox';
        all.checked = chooser.allBulkLanguages;
        all.dataset.zipperAllLanguages = 'true';
        all.id = 'zipper-all-languages-' + chooser.context.itemId;
        chooser.languageSlot.appendChild(makeLabeledInput(localized('chooser.allLanguages', 'All supported associated subtitle languages'), all, 'zipper-option zipper-all-languages'));
        var list = makeElement('div', 'zipper-language-list');
        var prefSet = new Set((chooser.preferences.subtitleLanguages || []).map(function (value) { return value.toLowerCase(); }));
        chooser.knownLanguages.forEach(function (language, index) {
            var input = document.createElement('input');
            input.type = 'checkbox';
            input.value = language;
            input.id = 'zipper-language-' + index + '-' + chooser.context.itemId;
            input.setAttribute('data-zipper-language-value', 'true');
            if (!chooser.allBulkLanguages && chooser.selectedBulkLanguages !== null) input.checked = chooser.selectedBulkLanguages.some(function (value) { return value.toLowerCase() === language.toLowerCase(); });
            else input.checked = !chooser.allBulkLanguages && (prefSet.size === 0 || prefSet.has(language.toLowerCase()));
            input.disabled = chooser.allBulkLanguages;
            var label = makeLabeledInput(languageLabelNode(language, 'zipper-field-label zipper-language-label'), input, 'zipper-option zipper-language-option');
            list.appendChild(label);
            chooser.languageInputs.push(input);
        });
        chooser.languageSlot.appendChild(list);
        var missingPreferences = Array.from(prefSet).filter(function (language) {
            return !chooser.knownLanguages.some(function (available) { return available.toLowerCase() === language; });
        });
        if (missingPreferences.length) chooser.languageSlot.appendChild(makeElement('p', 'zipper-field-help', localized('chooser.missingLanguageChoices', 'Some saved language choices are not present in this selection. They are not included in this preview.')));
    }

    function currentLanguages(chooser) {
        if (chooser.context.itemType !== 'series' && chooser.context.itemType !== 'season') return [];
        if (chooser.allBulkLanguages) return [];
        return Array.prototype.map.call(chooser.languageSlot.querySelectorAll('[data-zipper-language-value]:checked'), function (input) { return input.value; });
    }

    function currentIndices(chooser) {
        if (chooser.context.itemType !== 'movie' && chooser.context.itemType !== 'episode') return [];
        var tracks = currentTrackList(chooser);
        var selected = chooser.trackRows.querySelectorAll('[data-zipper-track-index]:checked');
        if (selected.length === tracks.length) return [];
        return Array.prototype.map.call(selected, function (input) { return Number(input.value); });
    }

    function requestForChooser(chooser, discovery) {
        var mode = modeOf(chooser);
        var languages = (chooser.context.itemType === 'season' || chooser.context.itemType === 'series') ? currentLanguages(chooser) : [];
        if (discovery && (chooser.context.itemType === 'season' || chooser.context.itemType === 'series')) languages = [];
        var selectedIndices = mode === 'mediaOnly' ? [] : currentIndices(chooser);
        if (mode === 'mediaOnly') languages = [];
        var seasonIds = [];
        if (chooser.context.itemType === 'series' && !chooser.seriesState.wholeSeries) {
            seasonIds = Array.from(chooser.seriesState.selectedSeasons);
        }
        var sourceId = chooser.context.itemType !== 'season' && chooser.context.itemType !== 'series'
            && chooser.selectedSource && UUID_PATTERN.test(chooser.selectedSource.id) ? chooser.selectedSource.id : null;
        return {
            itemId: chooser.context.itemId,
            mode: mode,
            languages: languages,
            subtitleIndices: selectedIndices,
            seasonIds: seasonIds,
            mediaSourceId: sourceId
        };
    }

    function selectionIsValid(chooser, discovery) {
        if (chooser.context.itemType === 'series' && !chooser.seriesState.wholeSeries && !chooser.seriesState.selectedSeasons.size) return false;
        var mode = modeOf(chooser);
        if (mode === 'mediaOnly') return true;
        if (chooser.context.itemType === 'movie' || chooser.context.itemType === 'episode') {
            var tracks = currentTrackList(chooser);
            if (!tracks.length) return true;
            return chooser.trackRows.querySelectorAll('[data-zipper-track-index]:checked').length > 0;
        }
        if (!discovery && !chooser.allBulkLanguages && !chooser.languageSlot.querySelector('[data-zipper-language-value]:checked')) return false;
        return true;
    }

    function invalidateChooser(chooser, discover) {
        chooser.revision += 1;
        chooser.preview = null;
        chooser.previewRevision = -1;
        chooser.submittedRevision = -1;
        if (discover) {
            if ((chooser.context.itemType === 'series' || chooser.context.itemType === 'season')
                && !chooser.allBulkLanguages && chooser.selectedBulkLanguages === null) {
                chooser.selectedBulkLanguages = currentLanguages(chooser);
            }
            chooser.discoveryNeeded = true;
            chooser.knownLanguages = [];
            renderLanguageControls(chooser);
        }
        updateChooserControls(chooser);
        if (chooser.previewTimer) window.clearTimeout(chooser.previewTimer);
        chooser.previewTimer = window.setTimeout(function () {
            chooser.previewTimer = 0;
            schedulePreview(chooser, chooser.discoveryNeeded);
        }, 280);
    }

    function schedulePreview(chooser, discover) {
        if (!chooser || !isContextCurrent(chooser.context) || !selectionIsValid(chooser, !!discover)) {
            if (chooser) {
                chooser.preview = null;
                chooser.previewRevision = -1;
                setTranslatedText(chooser.previewSummary, 'chooser.chooseContents', 'Choose package contents to preview.');
                renderWarnings(chooser.previewWarnings, []);
                chooser.fileList.replaceChildren();
                updateChooserControls(chooser);
            }
            return;
        }
        var modal = chooser.modal;
        var revision = chooser.revision;
        var client = identity().client;
        var body = requestForChooser(chooser, !!discover);
        chooser.preview = null;
        chooser.previewRevision = -1;
        setTranslatedText(chooser.previewSummary, 'chooser.checkingFiles', 'Checking selected files…');
        chooser.previewWarnings.replaceChildren();
        chooser.fileList.replaceChildren();
        chooser.status.textContent = '';
        updateChooserControls(chooser);
        request(client, 'Preview', 'POST', body).then(function (preview) {
            if (state.modal !== modal || modal.chooser !== chooser || !isContextCurrent(chooser.context) || revision !== chooser.revision) return;
            if (discover && (chooser.context.itemType === 'series' || chooser.context.itemType === 'season')) {
                var newlyDiscovered = languagesFromTracks(preview.subtitleTracks);
                var previousSelection = chooser.selectedBulkLanguages;
                chooser.knownLanguages = newlyDiscovered;
                chooser.discoveryNeeded = false;
                if (previousSelection !== null && !chooser.allBulkLanguages) {
                    var retainedLanguages = previousSelection.filter(function (language) {
                        return newlyDiscovered.some(function (available) { return available.toLowerCase() === language.toLowerCase(); });
                    });
                    if (retainedLanguages.length) {
                        chooser.selectedBulkLanguages = retainedLanguages;
                        chooser.allBulkLanguages = false;
                    chooser.preferenceWarning = retainedLanguages.length === previousSelection.length ? ''
                            : localized('warning.preferenceUpdatedSeasons', 'Some selected languages are not listed for the updated season selection; the remaining selected languages are still applied.');
                    } else {
                        chooser.selectedBulkLanguages = null;
                        chooser.allBulkLanguages = true;
                        chooser.preferenceWarning = localized('warning.preferenceNoUpdatedSeasons', 'The selected languages are not listed for the updated season selection. All supported associated tracks are selected; review the language choice before downloading.');
                    }
                } else if (!chooser.userTouchedLanguages && previousSelection === null && chooser.preferences.subtitleLanguages.length) {
                    var preferred = chooser.preferences.subtitleLanguages.filter(function (language) {
                        return newlyDiscovered.some(function (available) { return available.toLowerCase() === language.toLowerCase(); });
                    });
                    chooser.preferenceWarning = preferred.length ? '' : localized('warning.preferenceMissingSeasons', 'Saved subtitle languages are not listed for these seasons. All supported associated tracks remain selected by default.');
                    renderChooserWarnings(chooser);
                    if (preferred.length) {
                        chooser.selectedBulkLanguages = preferred;
                        chooser.allBulkLanguages = preferred.length === newlyDiscovered.length;
                    }
                }
                renderLanguageControls(chooser);
                if (!chooser.userTouchedLanguages && chooser.selectedBulkLanguages && chooser.selectedBulkLanguages.length) {
                    chooser.languageInputs.forEach(function (input) {
                        input.checked = chooser.selectedBulkLanguages.some(function (language) { return language.toLowerCase() === input.value.toLowerCase(); });
                    });
                }
                var nowLanguages = currentLanguages(chooser);
                var shouldRefilter = nowLanguages.length > 0 && nowLanguages.length !== newlyDiscovered.length;
                if (shouldRefilter) {
                    chooser.revision += 1;
                    updateChooserControls(chooser);
                    schedulePreview(chooser, false);
                    return;
                }
            }
            chooser.preview = preview;
            chooser.previewRevision = revision;
            renderPreview(chooser, preview);
            updateChooserControls(chooser);
        }).catch(function (error) {
            if (state.modal !== modal || modal.chooser !== chooser || !isContextCurrent(chooser.context) || revision !== chooser.revision) return;
            handleAuthorizationFailure(error);
            if (state.modal !== modal) return;
            chooser.preview = null;
            chooser.previewRevision = -1;
            setTranslatedText(chooser.previewSummary, 'chooser.cannotPreview', 'This selection cannot be previewed.');
            renderWarnings(chooser.previewWarnings, []);
            var previewError = makeElement('p', 'zipper-warning', '');
            chooser.previewWarnings.appendChild(previewError);
            Promise.resolve(errorMessage(error, localized('chooser.previewError', 'Zipper could not validate this selection. Change the selection or try again.'))).then(function (message) {
                if (state.modal === modal && revision === chooser.revision) previewError.textContent = message;
            });
            chooser.fileList.replaceChildren();
            updateChooserControls(chooser);
        });
    }

    function renderPreview(chooser, preview) {
        var items = translations.plural('preview.items', preview.itemCount, { one: '{count} item', few: '{count} items', many: '{count} items', other: '{count} items' });
        var files = translations.plural('preview.files', preview.entryCount, { one: '{count} file', few: '{count} files', many: '{count} files', other: '{count} files' });
        setTranslatedText(chooser.previewSummary, 'preview.sourceContents', '{items} · {files} · {size} source contents', { items: items, files: files, size: formatBytes(preview.totalBytes) });
        renderWarnings(chooser.previewWarnings, preview.warnings || []);
        chooser.fileList.replaceChildren();
        (Array.isArray(preview.fileNames) ? preview.fileNames : []).slice(0, 100).forEach(function (name) {
            chooser.fileList.appendChild(makeElement('li', '', name));
        });
        if (preview.entryCount > 100) {
            chooser.fileList.appendChild(makeElement('li', 'zipper-file-list-more', localized('preview.moreEntries', 'Showing the first {count} archive entries.', { count: translations.number(100) })));
        }
        if (!preview.canDownload) chooser.previewWarnings.appendChild(makeElement('p', 'zipper-warning', localized('preview.cannotDownload', 'This package cannot be downloaded with the current selection.')));
    }

    function renderWarnings(container, warnings) {
        container.replaceChildren();
        (warnings || []).slice(0, 30).forEach(function (warning) {
            if (typeof warning === 'string' && warning.trim()) {
                var item = makeElement('p', 'zipper-warning', warningText(warning));
                container.appendChild(item);
            }
        });
    }

    function updateChooserControls(chooser) {
        var mode = modeOf(chooser);
        var enabled = chooser.submittedRevision !== chooser.revision && selectionIsValid(chooser) && !chooser.pending && chooser.preview
            && chooser.previewRevision === chooser.revision && chooser.preview.canDownload === true;
        chooser.downloadButton.disabled = !enabled;
        if (chooser.pending) setTranslatedText(chooser.status, 'chooser.createAndStart', 'Creating the package and starting a browser-managed download…');
        else chooser.status.textContent = '';
        var modeOnly = mode === 'mediaOnly';
        chooser.tracksField.classList.toggle('zipper-disabled-section', modeOnly);
        chooser.trackInputs.forEach(function (input) { input.disabled = modeOnly || chooser.pending; });
        chooser.languageInputs.forEach(function (input) { input.disabled = modeOnly || chooser.pending || chooser.allBulkLanguages; });
        chooser.languageSlot.querySelectorAll('input').forEach(function (input) {
            if (input.dataset.zipperAllLanguages === 'true') input.disabled = modeOnly || chooser.pending;
        });
        if (chooser.context.itemType === 'series') {
            chooser.allSeasonsInput.disabled = chooser.pending;
            chooser.seasonRows.querySelectorAll('input[type="checkbox"]').forEach(function (input) { input.disabled = chooser.pending || chooser.seriesState.wholeSeries; });
        }
        chooser.modeInputs.forEach(function (input) { input.disabled = chooser.pending; });
        chooser.sourceSelect.disabled = chooser.pending || chooser.mediaSources.length < 2;
    }

    function showChooser(modal) {
        if (!modal || modal !== state.modal || !modal.chooser) return;
        showScreen(modal, 'chooser', modal.chooser.root, localized('dialog.loadingTitle', 'Download ZIP'), null);
    }

    function submitPackage(chooser) {
        if (!chooser || chooser.pending || !isContextCurrent(chooser.context) || !selectionIsValid(chooser)
            || !chooser.preview || chooser.previewRevision !== chooser.revision || chooser.preview.canDownload !== true) return;
        var capacityMessage = downloadCapacityMessage();
        if (capacityMessage) {
            chooser.previewWarnings.replaceChildren(makeElement('p', 'zipper-warning', capacityMessage));
            return;
        }
        var modal = chooser.modal;
        var revision = chooser.revision;
        var body = requestForChooser(chooser, false);
        if ((chooser.context.itemType === 'series' || chooser.context.itemType === 'season') && chooser.allBulkLanguages) body.languages = [];
        chooser.pending = true;
        chooser.status.setAttribute('role', 'status');
        updateChooserControls(chooser);
        request(identity().client, 'Packages', 'POST', body).then(function (created) {
            if (!isContextCurrent(chooser.context) || revision !== chooser.revision) return;
            if (!created || !created.job || !UUID_PATTERN.test(String(created.job.id || ''))) throw new Error(translate('chooser.packageResponseIncomplete', 'The package response was incomplete. Try again.'));
            var ticket = String(created.ticket || '');
            if (!TICKET_PATTERN.test(ticket)) throw new Error(translate('chooser.ticketInvalid', 'The download ticket could not be validated. Create the package again.'));
            launchBrowserDownload(created, chooser.context);
            chooser.pending = false;
            chooser.submittedRevision = revision;
            setTranslatedText(chooser.previewSummary, 'chooser.packagePrepared', 'Package prepared · {size} source contents', { size: formatBytes(chooser.preview.totalBytes) });
            updateChooserControls(chooser);
            setTranslatedText(chooser.status, 'chooser.submitted', 'The browser-managed ZIP download was submitted. The server reports transfer status in the download center.');
            if (state.modal === modal) {
                var centerLink = makeButton(localized('center.title', 'Downloads'), 'emby-button button-flat zipper-secondary-button', 'history', localized('chooser.downloadCenterAria', 'Open download center'));
                centerLink.addEventListener('click', function () { openCenter(chooser.context, function () { showChooser(modal); }); });
                chooser.status.appendChild(centerLink);
            }
            updatePolling();
        }).catch(function (error) {
            if (!isContextCurrent(chooser.context) || state.modal !== modal) return;
            chooser.pending = false;
            handleAuthorizationFailure(error);
            chooser.preview = null;
            chooser.previewRevision = -1;
            chooser.status.textContent = '';
            Promise.resolve(errorMessage(error, localized('chooser.createError', 'The package could not be created. Review the selection and try again.'))).then(function (message) {
                if (state.modal !== modal || !isContextCurrent(chooser.context) || chooser.revision !== revision) return;
                chooser.previewWarnings.replaceChildren(makeElement('p', 'zipper-warning', message));
                updateChooserControls(chooser);
            });
        });
    }

    function launchBrowserDownload(created, context) {
        var client = identity().client;
        var jobId = normalizeGuid(created.job.id);
        var currentKey = identity().key;
        var capacityMessage = downloadCapacityMessage();
        if (capacityMessage) throw new Error(capacityMessage);
        if (!jobId || !client || !isContextCurrent(context)) throw new Error(translate('chooser.sessionMismatch', 'The package response no longer matches this Jellyfin session.'));
        if (String(created.downloadPath || '') !== '/Zipper/Download') throw new Error(translate('chooser.routeUnexpected', 'The package download route was unexpected.'));
        var url = client.getUrl(created.downloadPath);
        var resolved;
        try { resolved = new URL(url, window.location.href); } catch (_) { throw new Error(translate('chooser.routeInvalid', 'The package download route is invalid.')); }
        if (!resolved.pathname.endsWith('/Zipper/Download') || resolved.search || resolved.hash || resolved.origin !== window.location.origin) {
            throw new Error(translate('chooser.routeMismatch', 'The package download route did not match this Jellyfin server.'));
        }
        var iframe = document.createElement('iframe');
        var frameName = 'zipper-download-' + jobId;
        iframe.name = frameName;
        iframe.title = translate('chooser.frameTitle', 'Zipper package download');
        iframe.setAttribute('aria-hidden', 'true');
        iframe.tabIndex = -1;
        iframe.className = 'zipper-download-frame';
        var form = document.createElement('form');
        form.method = 'POST';
        form.action = resolved.href;
        form.target = frameName;
        form.enctype = 'application/x-www-form-urlencoded';
        form.acceptCharset = 'UTF-8';
        form.className = 'zipper-download-form';
        var ticketInput = document.createElement('input');
        ticketInput.type = 'hidden';
        ticketInput.name = 'ticket';
        ticketInput.value = String(created.ticket);
        form.appendChild(ticketInput);
        var downloadStartedAt = Date.now();
        var record = {
            frame: iframe,
            identityKey: currentKey,
            jobId: jobId,
            expiresAt: Date.parse(created.ticketExpiresAt || '') || downloadStartedAt + 600000,
            startedAt: downloadStartedAt,
            missingSince: 0,
            missingChecks: 0,
            statusCheckPending: false,
            cleanupTimer: 0
        };
        state.downloads.set(jobId, record);
        document.body.appendChild(iframe);
        document.body.appendChild(form);
        try {
            form.submit();
        } catch (error) {
            state.downloads.delete(jobId);
            iframe.remove();
            throw error;
        } finally {
            window.setTimeout(function () {
                ticketInput.value = '';
                form.remove();
            }, 0);
        }
    }

    function downloadCapacityMessage() {
        var activeCount = Array.from(state.downloads.values()).filter(function (record) { return !record.terminalAt; }).length;
        if (activeCount >= 8) return translate('chooser.capacity.active', 'Eight package downloads are already active in this browser. Wait for one to finish before starting another.');
        if (state.downloads.size >= 16) return translate('chooser.capacity.frames', 'The browser has too many pending Zipper download frames. Wait for a status refresh before starting another.');
        return '';
    }

    function isCenterVisible() {
        return !!(state.modal && state.modal.currentView === 'center' && visible(state.modal.overlay));
    }

    function updatePolling() {
        var currentKey = identity().key;
        var ownsCurrentFrames = state.jobPollingUnavailableFor !== currentKey
            && Array.from(state.downloads.values()).some(function (record) { return record.identityKey === currentKey; });
        var shouldPoll = document.visibilityState === 'visible' && (ownsCurrentFrames || (isCenterVisible() && !state.modal.centerChecking));
        if (shouldPoll && !state.pollTimer) {
            state.pollTimer = window.setInterval(refreshJobs, 3000);
            if (isCenterVisible() || ownsCurrentFrames) refreshJobs();
        } else if (!shouldPoll && state.pollTimer) {
            window.clearInterval(state.pollTimer);
            state.pollTimer = 0;
        }
    }

    function refreshJobs() {
        var current = identity();
        if (!current.client || !current.userId || !current.serverId || state.jobLoading || document.visibilityState !== 'visible') return;
        var visibleCenter = isCenterVisible();
        var ownedFrames = Array.from(state.downloads.values()).filter(function (record) { return record.identityKey === current.key; });
        if (!visibleCenter && !ownedFrames.length) return;
        state.jobLoading = true;
        var requestId = ++state.jobRequest;
        request(current.client, 'Jobs', 'GET').then(function (jobs) {
            if (requestId !== state.jobRequest || identity().key !== current.key) return;
            var list = Array.isArray(jobs) ? jobs.slice(0, 128) : [];
            var listedIds = new Set(list.map(function (job) { return normalizeGuid(job && job.id); }).filter(Boolean));
            if (state.modal && state.modal.center) renderJobList(state.modal.center, list);
            list.forEach(function (job) {
                var record = state.downloads.get(normalizeGuid(job.id));
                if (!record || record.identityKey !== current.key || !isTerminal(job.state)) return;
                record.terminalAt = record.terminalAt || Date.now();
                if (record.cleanupTimer) return;
                record.cleanupTimer = window.setTimeout(function () {
                    if (state.downloads.get(record.jobId) === record) {
                        record.frame.remove();
                        state.downloads.delete(record.jobId);
                        updatePolling();
                    }
                }, job.state === 'completed' ? 60000 : 10000);
            });
            ownedFrames.filter(function (record) { return !listedIds.has(normalizeGuid(record.jobId)); })
                .forEach(function (record) { verifyMissingJob(record, current, requestId); });
        }).catch(function (error) {
            if (requestId !== state.jobRequest || identity().key !== current.key) return;
            handleAuthorizationFailure(error);
            if (state.modal && state.modal.center && state.modal.center.error) {
                var errorCenter = state.modal.center;
                Promise.resolve(errorMessage(error, localized('center.loadError', 'Zipper could not load download history.'))).then(function (message) {
                    if (state.modal && state.modal.center === errorCenter && identity().key === current.key) errorCenter.error.textContent = message;
                });
            }
        }).finally(function () {
            if (requestId === state.jobRequest) state.jobLoading = false;
        });
    }

    function verifyMissingJob(record, current, requestId) {
        if (!record || record.identityKey !== current.key || record.terminalAt || record.statusCheckPending || !state.downloads.has(record.jobId)) return;
        record.statusCheckPending = true;
        request(current.client, 'Jobs/' + encodeURIComponent(record.jobId), 'GET').then(function (job) {
            if (requestId !== state.jobRequest || identity().key !== current.key || state.downloads.get(record.jobId) !== record) return;
            record.missingSince = 0;
            record.missingChecks = 0;
            if (job && isTerminal(job.state)) scheduleDownloadFrameCleanup(record, job.state);
        }).catch(function (error) {
            if (requestId !== state.jobRequest || identity().key !== current.key || state.downloads.get(record.jobId) !== record) return;
            if (statusOf(error) !== 404) {
                handleAuthorizationFailure(error);
                return;
            }
            record.missingSince = record.missingSince || Date.now();
            record.missingChecks += 1;
            // The server retains active jobs; a missing per-job record after repeated fresh
            // checks means its bounded terminal history or server process has discarded it.
            if (record.missingChecks >= 2 && Date.now() - record.missingSince >= 3000 && Date.now() >= record.expiresAt) {
                scheduleDownloadFrameCleanup(record, 'expired');
            }
        }).finally(function () { record.statusCheckPending = false; });
    }

    function scheduleDownloadFrameCleanup(record, status) {
        if (!record || record.cleanupTimer || !state.downloads.has(record.jobId)) return;
        record.terminalAt = record.terminalAt || Date.now();
        record.cleanupTimer = window.setTimeout(function () {
            if (state.downloads.get(record.jobId) === record) {
                record.frame.remove();
                state.downloads.delete(record.jobId);
                updatePolling();
            }
        }, String(status).toLowerCase() === 'completed' ? 60000 : 10000);
    }

    function isTerminal(status) {
        return ['completed', 'cancelled', 'failed', 'expired'].indexOf(String(status || '').toLowerCase()) !== -1;
    }

    function openCenter(context, backAction) {
        if (!context || !isContextCurrent(context)) return;
        state.jobPollingUnavailableFor = '';
        var modal = state.modal || createModal(context);
        if (modal.context.identityKey !== context.identityKey || modal.context.routeKey !== context.routeKey) return;
        modal.centerChecking = true;
        var root = makeElement('div', 'zipper-center');
        var intro = makeElement('p', 'zipper-center-intro', localized('center.intro', 'Your browser tracks download progress. You can cancel or retry packages here.'));
        root.appendChild(intro);
        var error = makeElement('p', 'zipper-inline-error');
        error.setAttribute('role', 'alert');
        root.appendChild(error);
        var tools = makeElement('div', 'zipper-center-tools');
        var refresh = makeButton(localized('center.refresh', 'Refresh'), 'emby-button button-flat zipper-secondary-button', 'refresh', localized('center.refreshAria', 'Refresh package status'));
        var preferences = makeButton(localized('center.preferences', 'Preferences'), 'emby-button button-flat zipper-secondary-button', 'tune', localized('center.preferencesAria', 'Edit account package preferences'));
        tools.appendChild(refresh);
        tools.appendChild(preferences);
        root.appendChild(tools);
        var list = makeElement('div', 'zipper-job-list');
        list.setAttribute('aria-live', 'polite');
        list.appendChild(makeElement('p', 'zipper-loading', localized('center.loading', 'Loading package history…')));
        root.appendChild(list);
        var center = { root: root, list: list, error: error, refresh: refresh, preferences: preferences, jobs: [], pendingActions: new Set() };
        modal.center = center;
        refresh.addEventListener('click', function () { refreshJobs(); });
        preferences.addEventListener('click', function () {
            var current = identity();
            if (current.key !== context.identityKey || !isContextCurrent(context)) return;
            request(current.client, 'Preferences', 'GET').then(function (result) {
                if (state.modal !== modal || !isContextCurrent(context)) return;
                openPreferences(modal, normalizePreferences(result), [], function () { openCenter(context, backAction); });
            }).catch(function (failure) {
                if (state.modal !== modal || !isContextCurrent(context) || identity().key !== current.key) return;
                handleAuthorizationFailure(failure);
                Promise.resolve(errorMessage(failure, localized('preferences.loadError', 'Zipper could not load account preferences.'))).then(function (message) {
                    if (state.modal === modal && isContextCurrent(context) && identity().key === current.key) error.textContent = message;
                });
            });
        });
        showScreen(modal, 'center', root, localized('center.title', 'Downloads'), backAction);
        ensureCapabilities(true).then(function (caps) {
            if (modal !== state.modal || !isContextCurrent(context)) return;
            modal.centerChecking = false;
            if (!caps) {
                closeModal();
                return;
            }
            updatePolling();
            refreshJobs();
        });
    }

    function renderJobList(center, jobs) {
        if (!center || !center.list) return;
        center.jobs = jobs;
        center.list.replaceChildren();
        if (!jobs.length) {
            center.list.appendChild(makeElement('p', 'zipper-empty-note', localized('center.empty', 'No recent Zipper packages are available for this Jellyfin account.')));
            return;
        }
        jobs.forEach(function (job) {
            if (!job || !normalizeGuid(job.id)) return;
            var card = makeElement('article', 'zipper-job');
            var header = makeElement('div', 'zipper-job-header');
            header.appendChild(makeElement('h3', 'zipper-job-title', job.title || localized('center.package', 'Package')));
            header.appendChild(makeElement('span', 'zipper-job-state zipper-state-' + String(job.state || '').toLowerCase(), stateLabel(job.state)));
            card.appendChild(header);
            card.appendChild(makeElement('p', 'zipper-job-description', stateDescription(job)));
            card.appendChild(makeElement('p', 'zipper-job-bytes', Number(job.bytesSentByServer) > 0
                ? localized('center.serverBytesSent', '{size} sent by the server', { size: formatBytes(job.bytesSentByServer) })
                : localized('center.noResponseBytes', 'No response bytes sent by the server yet')));
            if (job.error) card.appendChild(makeElement('p', 'zipper-job-error', Object.prototype.hasOwnProperty.call(JOB_ERROR_TEXT, job.error) ? JOB_ERROR_TEXT[job.error] : localized('center.jobError.unknown', 'Try creating a new package.')));
            var actions = makeElement('div', 'zipper-job-actions');
            if (ACTIVE_STATES[String(job.state || '').toLowerCase()]) {
                var cancel = makeButton(localized('center.cancel', 'Cancel'), 'emby-button button-flat zipper-secondary-button', 'cancel', localized('center.cancelFor', 'Cancel package {title}', { title: job.title || 'download' }));
                cancel.disabled = center.pendingActions && center.pendingActions.has(normalizeGuid(job.id));
                cancel.addEventListener('click', function () { cancelJob(job.id, center); });
                actions.appendChild(cancel);
            }
            if (job.canRetry === true) {
                var retryLabel = String(job.state).toLowerCase() === 'completed'
                    ? localized('center.downloadAgain', 'Download again') : localized('center.retry', 'Retry package');
                var retry = makeButton(retryLabel, 'emby-button button-flat zipper-secondary-button', 'refresh', localized('center.retryFor', '{action} for {title}', { action: translate(retryLabel.key, retryLabel.fallback), title: job.title || 'package' }));
                setLocalizedRenderer(retry, function () {
                    retry.setAttribute('aria-label', translate('center.retryFor', '{action} for {title}', { action: translate(retryLabel.key, retryLabel.fallback), title: job.title || 'package' }));
                });
                retry.disabled = center.pendingActions && center.pendingActions.has(normalizeGuid(job.id));
                retry.addEventListener('click', function () { retryJob(job.id, center); });
                actions.appendChild(retry);
            }
            if (actions.childNodes.length) card.appendChild(actions);
            center.list.appendChild(card);
        });
    }

    function stateLabel(status) {
        var key = String(status || '').toLowerCase();
        var labels = { ready: 'Ready', validating: 'Checking files', streaming: 'Streaming', cancelling: 'Cancelling', completed: 'Sent', cancelled: 'Cancelled', failed: 'Failed', expired: 'Expired' };
        return localized('center.state.' + (labels[key] ? key : 'unknown'), labels[key] || 'Unknown');
    }

    function stateDescription(job) {
        var messages = {
            ready: 'The package is ready to stream.',
            validating: 'The server is checking access and source files.',
            streaming: 'The server is streaming this package to the browser.',
            cancelling: 'The server is stopping this transfer.',
            completed: 'The server finished sending the response.',
            cancelled: 'The transfer was cancelled. An incomplete ZIP may remain on the device.',
            failed: 'The server could not finish this package.',
            expired: 'The one-use download ticket expired. Create a fresh package to download again.'
        };
        var stateName = String(job.state || '').toLowerCase();
        return localized('center.description.' + (messages[stateName] ? stateName : 'unknown'), messages[stateName] || 'Transfer status is unavailable.');
    }

    function cancelJob(jobId, center) {
        jobId = normalizeGuid(jobId);
        if (!jobId || center.pendingActions.has(jobId)) return;
        var current = identity();
        var modal = state.modal;
        var context = modal && modal.context;
        if (!context || !isContextCurrent(context) || current.key !== context.identityKey) return;
        center.pendingActions.add(jobId);
        request(current.client, 'Jobs/' + encodeURIComponent(jobId), 'DELETE').then(function (job) {
            if (state.modal === modal && modal.center === center && isContextCurrent(context) && identity().key === current.key) {
                var jobs = center.jobs.map(function (entry) { return sameGuid(entry.id, job.id) ? job : entry; });
                renderJobList(center, jobs);
            }
        }).catch(function (error) {
            if (state.modal !== modal || modal.center !== center || !isContextCurrent(context) || identity().key !== current.key) return;
            handleAuthorizationFailure(error);
            Promise.resolve(errorMessage(error, localized('center.cancelError', 'Zipper could not cancel this package.'))).then(function (message) {
                if (state.modal === modal && modal.center === center && isContextCurrent(context) && identity().key === current.key) center.error.textContent = message;
            });
        }).finally(function () {
            center.pendingActions.delete(jobId);
            if (state.modal === modal && modal.center === center && isContextCurrent(context)) renderJobList(center, center.jobs);
        });
    }

    function retryJob(jobId, center) {
        jobId = normalizeGuid(jobId);
        if (!jobId || center.pendingActions.has(jobId)) return;
        var current = identity();
        var context = state.modal && state.modal.context;
        if (!context || !isContextCurrent(context)) return;
        var capacityMessage = downloadCapacityMessage();
        if (capacityMessage) {
            center.error.textContent = capacityMessage;
            return;
        }
        center.pendingActions.add(jobId);
        center.error.textContent = '';
        request(current.client, 'Jobs/' + encodeURIComponent(jobId) + '/Retry', 'POST').then(function (created) {
            if (!isContextCurrent(context) || state.modal && state.modal.center !== center) return;
            launchBrowserDownload(created, context);
            refreshJobs();
            setTranslatedText(center.error, 'center.retrySuccess', 'A fresh package was prepared and submitted to the browser download manager.');
        }).catch(function (error) {
            if (!isContextCurrent(context) || identity().key !== current.key || state.modal && state.modal.center !== center) return;
            handleAuthorizationFailure(error);
            Promise.resolve(errorMessage(error, localized('center.retryError', 'Zipper could not retry this package.'))).then(function (message) {
                if (isContextCurrent(context) && identity().key === current.key && state.modal && state.modal.center === center) center.error.textContent = message;
            });
        }).finally(function () {
            center.pendingActions.delete(jobId);
            if (state.modal && state.modal.center === center && isContextCurrent(context)) renderJobList(center, center.jobs);
        });
    }

    function openPreferences(modal, preferences, availableLanguages, backAction) {
        if (!modal || modal !== state.modal || !isContextCurrent(modal.context)) return;
        var currentPreferences = normalizePreferences(preferences);
        var languageChoices = Array.from(new Set((availableLanguages || []).concat(currentPreferences.subtitleLanguages || [])))
            .filter(function (language) { return typeof language === 'string' && language.length <= 35; });
        var root = makeElement('div', 'zipper-preferences');
        root.appendChild(makeElement('p', 'zipper-center-intro', localized('preferences.intro', 'Your preferences are saved to your Jellyfin account and apply on your other signed-in devices.')));
        var modeField = makeElement('fieldset', 'zipper-fieldset');
        modeField.appendChild(makeElement('legend', '', localized('preferences.mode', 'Default package contents')));
        var modeInputs = [];
        MODES.forEach(function (mode, index) {
            var input = document.createElement('input');
            input.type = 'radio';
            input.name = 'zipper-pref-mode-' + modal.context.itemId;
            input.value = mode.value;
            input.checked = mode.value === currentPreferences.mode;
            input.id = 'zipper-pref-mode-' + index + '-' + modal.context.itemId;
            modeField.appendChild(makeLabeledInput(localized('mode.' + mode.value, mode.label), input, 'zipper-option zipper-radio-option'));
            modeInputs.push(input);
        });
        root.appendChild(modeField);
        var languageField = makeElement('fieldset', 'zipper-fieldset');
        languageField.appendChild(makeElement('legend', '', localized('preferences.languages', 'Subtitle language defaults')));
        languageField.appendChild(makeElement('p', 'zipper-field-help', localized('preferences.languageHelp', 'Leave languages unchecked to include all supported tracks. Choose only languages listed in Jellyfin metadata.')));
        var languageInputs = [];
        if (!languageChoices.length) {
            languageField.appendChild(makeElement('p', 'zipper-empty-note', currentPreferences.subtitleLanguages.length
                ? localized('preferences.savedLanguages', 'Saved languages: {languages}. Open preferences from a package chooser to change them using tracks available for that item.', { languages: currentPreferences.subtitleLanguages.map(languageLabel).join(', ') })
                : localized('preferences.noLanguages', 'No language choices have been saved. All supported associated tracks are included by default.')));
        } else {
            languageChoices.forEach(function (language, index) {
                var input = document.createElement('input');
                input.type = 'checkbox';
                input.value = language;
                input.id = 'zipper-pref-language-' + index + '-' + modal.context.itemId;
                input.checked = currentPreferences.subtitleLanguages.some(function (saved) { return saved.toLowerCase() === language.toLowerCase(); });
                languageField.appendChild(makeLabeledInput(languageLabelNode(language, 'zipper-field-label zipper-language-label'), input, 'zipper-option zipper-language-option'));
                languageInputs.push(input);
            });
        }
        root.appendChild(languageField);
        var message = makeElement('p', 'zipper-inline-status');
        message.setAttribute('role', 'status');
        root.appendChild(message);
        var actions = makeElement('div', 'zipper-dialog-actions');
        var save = makeButton(localized('preferences.save', 'Save preferences'), 'emby-button raised zipper-primary-button', 'save', localized('preferences.saveAria', 'Save preferences to the Jellyfin account'));
        actions.appendChild(save);
        root.appendChild(actions);
        save.addEventListener('click', function () {
            if (save.disabled || !isContextCurrent(modal.context)) return;
            var selectedMode = modeInputs.find(function (input) { return input.checked; });
            var languages = languageInputs.filter(function (input) { return input.checked; }).map(function (input) { return input.value; });
            var client = identity().client;
            var requestIdentityKey = identity().key;
            save.disabled = true;
            setTranslatedText(message, 'preferences.saving', 'Saving preferences…');
            request(client, 'Preferences', 'PUT', {
                mode: selectedMode ? selectedMode.value : 'mediaAndSubtitles',
                subtitleLanguages: languages.slice(0, 20)
            }).then(function (saved) {
                if (!isContextCurrent(modal.context) || modal !== state.modal) return;
                var updated = normalizePreferences(saved);
                setTranslatedText(message, 'preferences.saved', 'Preferences saved to your Jellyfin account.');
                if (typeof backAction === 'function') {
                    window.setTimeout(function () {
                        if (modal === state.modal && modal.currentView === 'preferences' && isContextCurrent(modal.context)) backAction(updated);
                    }, 420);
                }
            }).catch(function (error) {
                if (modal !== state.modal || !isContextCurrent(modal.context) || identity().key !== requestIdentityKey) return;
                handleAuthorizationFailure(error);
                Promise.resolve(errorMessage(error, localized('preferences.saveError', 'Zipper could not save these preferences.'))).then(function (text) {
                    if (modal !== state.modal || !isContextCurrent(modal.context) || identity().key !== requestIdentityKey) return;
                    message.textContent = text;
                    save.disabled = false;
                });
            });
        });
        showScreen(modal, 'preferences', root, localized('preferences.title', 'Zipper preferences'), function () {
            if (modal === state.modal && isContextCurrent(modal.context) && typeof backAction === 'function') backAction();
        });
    }

    function formatBytes(value) {
        var bytes = Number(value);
        if (!Number.isFinite(bytes) || bytes < 0) return translate('bytes.unavailable', 'Size unavailable');
        var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        var index = 0;
        while (bytes >= 1024 && index < units.length - 1) { bytes /= 1024; index += 1; }
        var number = index === 0 ? Math.round(bytes) : Number(bytes.toFixed(bytes >= 10 ? 0 : 1));
        return translations.number(number, index === 0 ? { maximumFractionDigits: 0 } : { maximumFractionDigits: bytes >= 10 ? 0 : 1 }) + ' ' + units[index];
    }

    function bootstrap() {
        if (getClient() && document.documentElement) {
            wake();
            return;
        }
        var attempts = 0;
        var timer = window.setInterval(function () {
            attempts += 1;
            if (getClient() && document.documentElement) {
                window.clearInterval(timer);
                wake();
            } else if (attempts >= 100) {
                window.clearInterval(timer);
            }
        }, 200);
    }

    bootstrap();
}());
