/**
 * Clears and tracks per-session conversation timers.
 */
export class ConversationTimers {
  constructor(session) {
    this.session = session;
    if (!session.conversationTimers) {
      session.conversationTimers = {
        listen: null,
        idle: null,
        response: null,
        hangup: null,
      };
    }
  }

  clear(name) {
    const bag = this.session.conversationTimers;
    if (!bag) return;
    if (name) {
      if (bag[name]) {
        clearTimeout(bag[name]);
        bag[name] = null;
      }
      return;
    }
    for (const key of Object.keys(bag)) {
      if (bag[key]) {
        clearTimeout(bag[key]);
        bag[key] = null;
      }
    }
  }

  clearAll() {
    this.clear();
  }

  set(name, fn, ms) {
    this.clear(name);
    const bag = this.session.conversationTimers;
    bag[name] = setTimeout(() => {
      bag[name] = null;
      try {
        fn();
      } catch {
        // ignore timer errors
      }
    }, Math.max(0, ms));
    return bag[name];
  }
}

export function clearConversationTimers(session) {
  if (!session) return;
  new ConversationTimers(session).clearAll();
  if (session.failsafeHangupTimer) {
    clearTimeout(session.failsafeHangupTimer);
    session.failsafeHangupTimer = null;
  }
}
