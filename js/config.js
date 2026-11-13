/* Under Oath configuration. Classic script. */
(function () {
  'use strict';
  window.UO = window.UO || {};
  window.UO.config = {
    // Public App Key (pk_...) registered for this page's address. Safe to commit.
    APP_KEY: 'pk_wYDjYJBJ2E9p82UK',
    REPO_URL: 'https://github.com/patbing/under-oath',
    API: 'https://gen.pollinations.ai',
    // Free (not paid-only) text models, checked again against /v1/models at run time.
    DEFAULT_KEEPER: 'meta/llama-3.3-70b-instruct',
    DEFAULT_ASKER: 'openai/gpt-6-luna',
    REFEREE: 'nvidia/nemotron-3.5-lightning',
    REFEREE_ALT: 'z-ai/glm-5.3-flash',
    TIMEOUT_MS: 60000,
    // A live game stops itself before a call that could take it past this.
    MAX_SPEND: 0.03,
    // Worst case per call for the cap: a long history in, max_tokens out.
    WORST_IN_TOKENS: 2500
  };
})();
