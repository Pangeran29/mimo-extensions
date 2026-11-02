// Evaluation-only clock: production controller code uses these timers in an isolated bundle.
// Fetch, provider deadlines, and network-duration measurements retain the real clock.
export class ReplayClock {
  now = 0;
  nextId = 0;
  events = new Map();
  setTimeout = (callback, delay = 0) => {
    const id = ++this.nextId;
    this.events.set(id, { id, at: this.now + Math.max(0, delay), callback });
    return id;
  };
  clearTimeout = (id) => this.events.delete(id);
  at(at, callback) {
    return this.setTimeout(callback, Math.max(0, at - this.now));
  }
  next() {
    const event = [...this.events.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!event) return false;
    this.events.delete(event.id);
    this.now = event.at;
    event.callback();
    return true;
  }
}
