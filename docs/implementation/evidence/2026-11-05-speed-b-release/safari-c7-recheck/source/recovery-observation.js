const expectedOrigin = arguments[0];
const record = arguments[1];
const mode = arguments[2];
if (location.origin !== expectedOrigin || location.pathname !== '/r/' + record)
  throw Error('Unrelated origin or record');
const key = '__orbisSafariRecoveryObservation';
function describe(element) {
  if (!(element instanceof Element)) return null;
  return {
    tag: element.tagName,
    id: element.id,
    testId: element.getAttribute('data-testid'),
    role: element.getAttribute('role'),
    text: (element.textContent ?? '').trim().slice(0, 160),
  };
}
function current() {
  return {
    origin: location.origin,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    active: describe(document.activeElement),
    buttons: [...document.querySelectorAll('[data-testid="draft-banner"] button')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { ...describe(button), disabled: button.disabled,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    }),
  };
}
if (mode === 'install') {
  if (Object.hasOwn(window, key)) throw Error('Observer already installed');
  const events = [];
  const types = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'];
  const listen = (event) => {
    events.push({
      type: event.type,
      isTrusted: event.isTrusted,
      target: describe(event.target),
      path: event.composedPath().filter((node) => node instanceof Element).slice(0, 4).map(describe),
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      active: describe(document.activeElement),
      timeStamp: event.timeStamp,
      now: performance.now(),
      button: event.button,
      buttons: event.buttons,
      detail: event.detail,
      pointerType: event.pointerType ?? null,
      defaultPreventedAtCapture: event.defaultPrevented,
    });
  };
  for (const type of types) document.addEventListener(type, listen, { capture: true, passive: true });
  Object.defineProperty(window, key, {
    configurable: true,
    value: {
      read: () => ({ ...current(), events: events.slice() }),
      stop: () => {
        for (const type of types) document.removeEventListener(type, listen, true);
        delete window[key];
      },
    },
  });
  return { installed: true, ...current() };
}
if (mode === 'read-stop') {
  const observation = window[key];
  const result = observation ? observation.read() : { ...current(), installed: false, events: [] };
  observation?.stop();
  return result;
}
throw Error('Unsupported observation operation');
