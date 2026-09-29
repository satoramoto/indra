/**
 * Runs `publish` once after the current task, however many times the returned function is called in it.
 *
 * The terminal UI publishes the model's revision this way after each key. A burst of typed or unbracketed pasted
 * text arrives as one stdin chunk that OpenTUI turns into one key event per character, all in one task. Publishing
 * per key rebuilt the Solid tree for every character, creating native OpenTUI renderables faster than they are
 * freed; after about a thousand rebuilds native creation failed, the Solid update threw, and the screen stopped
 * updating while the process sat idle. Publishing once per chunk rebuilds the screen once.
 */
export function oncePerTask(publish: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      publish();
    });
  };
}
