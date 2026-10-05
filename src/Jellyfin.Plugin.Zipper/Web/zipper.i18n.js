(function (root) {
    'use strict';

    function supportedLocale(value) {
        var match = /^(de|es|fr|it|ja|ko|nl|pl|pt|ru|zh)(?:[-_]|$)/i.exec(String(value || '').trim());
        return match ? match[1].toLowerCase() : 'en';
    }

    function selectedLocale() {
        var pageLanguage = root.document && root.document.documentElement
            ? String(root.document.documentElement.getAttribute('lang') || '').trim() : '';
        var language = pageLanguage;
        if (!language) {
            var browserLanguages = root.navigator && Array.isArray(root.navigator.languages) ? root.navigator.languages : [];
            language = browserLanguages[0] || root.navigator && root.navigator.language || '';
        }
        return supportedLocale(language);
    }

    function create(urlForLocale) {
        var locale = selectedLocale();
        var dictionary = Object.create(null);
        var cache = Object.create(null);
        var loadRevision = 0;

        function loadLanguage(language) {
            if (cache[language]) return cache[language];
            var url;
            try {
                url = new URL(urlForLocale(language), root.location.href);
                if (url.origin !== root.location.origin || url.search || url.hash
                    || !url.pathname.endsWith('/Zipper/Locales/' + language)) throw new Error('Invalid locale route.');
            } catch (_) {
                return Promise.resolve(Object.create(null));
            }
            var request = root.fetch(url.href, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
                .then(function (response) {
                    if (!response.ok) throw new Error('Locale unavailable.');
                    return response.json();
                })
                .then(function (value) {
                    if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.create(null);
                    var safe = Object.create(null);
                    Object.keys(value).slice(0, 1200).forEach(function (key) {
                        if (/^[a-zA-Z0-9_.-]{1,100}$/.test(key) && typeof value[key] === 'string' && value[key].length <= 2000) {
                            safe[key] = value[key];
                        }
                    });
                    return safe;
                });
            var wrappedRequest = request.catch(function () {
                if (cache[language] === wrappedRequest) delete cache[language];
                return Object.create(null);
            });
            cache[language] = wrappedRequest;
            return cache[language];
        }

        function load() {
            var requestedLocale = selectedLocale();
            var revision = ++loadRevision;
            locale = requestedLocale;
            return loadLanguage(requestedLocale).then(function (loaded) {
                if (revision === loadRevision && selectedLocale() === requestedLocale) dictionary = loaded;
                return api;
            });
        }

        function interpolate(template, values) {
            var args = values || {};
            return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, function (match, name) {
                return Object.prototype.hasOwnProperty.call(args, name) ? String(args[name]) : match;
            });
        }

        function text(key, fallback, values) {
            var value = dictionary[key];
            return interpolate(typeof value === 'string' ? value : fallback, values);
        }

        function number(value, options) {
            try { return new Intl.NumberFormat(locale, options).format(value); } catch (_) { return String(value); }
        }

        function plural(key, count, fallbacks, values) {
            var category = 'other';
            try { category = new Intl.PluralRules(locale).select(Number(count)); } catch (_) { }
            var templates = fallbacks || {};
            var fallback = templates[category] || templates.other || '';
            var args = Object.assign({}, values || {}, { count: number(count) });
            return text(key + '.' + category, fallback, args);
        }

        function observe(onLocaleChange) {
            if (!root.MutationObserver || !root.document || !root.document.documentElement) return function () {};
            var lastLanguage = String(root.document.documentElement.getAttribute('lang') || '');
            var observerRevision = 0;
            var observer = new root.MutationObserver(function () {
                var nextLanguage = String(root.document.documentElement.getAttribute('lang') || '');
                if (nextLanguage === lastLanguage) return;
                lastLanguage = nextLanguage;
                var revision = ++observerRevision;
                load().then(function () {
                    if (revision === observerRevision && String(root.document.documentElement.getAttribute('lang') || '') === nextLanguage
                        && typeof onLocaleChange === 'function') onLocaleChange(locale);
                });
            });
            observer.observe(root.document.documentElement, { attributes: true, attributeFilter: ['lang'] });
            return function () { observer.disconnect(); };
        }

        var api = { load: load, text: text, plural: plural, number: number, locale: function () { return locale; }, observe: observe };
        return api;
    }

    root.ZipperI18n = { create: create, selectedLocale: selectedLocale };
}(window));
