// ============================================================
// PageContextReader — passively reads what's on screen
// Sends structured signals to USWM, not raw HTML
// ============================================================

export class PageContextReader {
  constructor() {
    this.lastSnapshot = null;
    this.watchInterval = null;
    this._callback = null;
    this._scrollHandler = null;
    this._scrollDebounceTimer = null;
    this.SNAPSHOT_INTERVAL = 10000; // Every 10s
  }

  // ── Start passive watching ───────────────────────────────
  startWatching(callback) {
    this._callback = callback;

    // Interval-based polling
    this.watchInterval = setInterval(() => {
      this._checkAndCallback();
    }, this.SNAPSHOT_INTERVAL);

    // Scroll-aware: re-snapshot 500ms after scrolling stops
    this._scrollHandler = () => {
      clearTimeout(this._scrollDebounceTimer);
      this._scrollDebounceTimer = setTimeout(() => {
        this._checkAndCallback();
      }, 500);
    };
    window.addEventListener('scroll', this._scrollHandler, { passive: true });
  }

  _checkAndCallback() {
    if (!this._callback) return;
    const snapshot = this.getSnapshot();
    const snapshotStr = JSON.stringify(snapshot);
    if (snapshotStr !== this.lastSnapshot) {
      this.lastSnapshot = snapshotStr;
      this._callback(snapshot);
    }
  }

  stopWatching() {
    clearInterval(this.watchInterval);
    if (this._scrollHandler) {
      window.removeEventListener('scroll', this._scrollHandler);
    }
    clearTimeout(this._scrollDebounceTimer);
  }

  // ── Get structured page snapshot ────────────────────────
  getSnapshot({ force = false } = {}) {
    // force=true bypasses any caching and re-reads the DOM now
    if (force) this.lastSnapshot = null;
    return {
      url: window.location.href,
      domain: window.location.hostname,
      title: document.title,
      pageType: this._classifyPage(),
      visibleText: this._getVisibleText(500),
      selectedText: window.getSelection()?.toString()?.slice(0, 200) || '',
      scrollDepth: this._getScrollDepth(),
      timeOnPage: this._getTimeOnPage(),
      focusedElement: this._getFocusedElementInfo(),
    };
  }

  // ── Classify what kind of page this is ──────────────────
  _classifyPage() {
    const url = window.location.href;

    if (url.includes('reddit.com')) return 'social_reddit';
    if (url.includes('twitter.com') || url.includes('x.com')) return 'social_twitter';
    if (url.includes('youtube.com')) return 'video';
    if (url.includes('news') || url.includes('cnn') || url.includes('bbc')) return 'news';
    if (url.includes('github.com')) return 'code';
    if (url.includes('linkedin.com')) return 'professional';
    if (url.includes('medium.com') || url.includes('substack')) return 'article';
    if (document.querySelector('article')) return 'article';
    if (document.querySelector('video')) return 'video';
    return 'general';
  }

  // ── Extract visible text (skip nav/footer noise) ─────────
  _getVisibleText(maxChars) {
    const skipSelectors = ['nav', 'footer', 'header', 'script', 'style', 'aside'];
    const main = document.querySelector('main, article, .content, #content, [role="main"]')
      || document.body;

    let text = '';
    const walker = document.createTreeWalker(
      main,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return NodeFilter.FILTER_REJECT;
          }

          if (skipSelectors.some(sel => parent.closest(sel))) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode()) && text.length < maxChars) {
      const trimmed = node.textContent.trim();
      if (trimmed.length > 20) {
        text += trimmed + ' ';
      }
    }

    return text.slice(0, maxChars).trim();
  }

  _getScrollDepth() {
    const scrolled = window.scrollY + window.innerHeight;
    const total = document.documentElement.scrollHeight;
    return Math.round((scrolled / total) * 100);
  }

  _getTimeOnPage() {
    if (!this._pageLoadTime) this._pageLoadTime = Date.now();
    return Math.round((Date.now() - this._pageLoadTime) / 1000);
  }

  _getFocusedElementInfo() {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return {
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      placeholder: el.placeholder || null,
    };
  }
}