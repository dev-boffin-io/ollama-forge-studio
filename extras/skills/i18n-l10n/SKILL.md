---
name: i18n-l10n
description: Internationalizes and localizes an app: extracts hard-coded strings, manages locale files, plurals, formats and RTL, and checks that every locale is complete.
---
# Workflow: i18n / l10n

1. **Detect the stack's i18n library and layout** (react-i18next, vue-i18n, FormatJS/react-intl, gettext, Rails/Django i18n, ICU message files…) and where locale files live. Use what exists; only add a library if there is none and the user agrees.
2. **Find hard-coded user-facing text** with `grep` (JSX text, template strings, alert/toast/log-to-user messages). Skip identifiers, log lines for developers, and test fixtures.
3. **Extract with stable keys:** `area.component.purpose` (e.g. `checkout.summary.total`), never the English sentence as the key. Keep placeholders named (`{count}`, `{name}`), never concatenate translated pieces.
4. **Handle the hard parts properly:** plurals via ICU/CLDR rules (not `if n == 1`), gender/select, dates, numbers, currency and relative time through `Intl` / the library formatters, text direction (`dir="rtl"`, logical CSS properties), longer text (German) and non-Latin fonts.
5. **Update locale files:** add the source locale fully; for other locales add the keys with the source text marked for translation (do not machine-translate silently unless asked) and keep key order identical.
6. **Verify completeness:** run a script or `grep`/`jq` check that every locale has exactly the same key set and the same placeholders; run the app's tests/build.
7. **Report:** keys added, locales missing translations, strings you left alone and why.

Rules: do not translate brand names, code or API fields; never change the meaning of existing translations; keep file encoding UTF-8.
