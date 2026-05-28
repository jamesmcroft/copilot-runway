// Runway agent picker (issue #53 iteration 2).
//
// Native HTML5 combobox built from <input list> + <datalist>. The
// browser handles typeahead, keyboard navigation, and the open-on-focus
// dropdown for free, which gives us a "proper combobox" without
// shipping a custom widget. Used today by the settings page to render
// the "Default agent" field as a picker that fetches from /api/agents.
//
// API:
//   const picker = RunwayAgentPicker.create({
//     host,            // HTMLElement to mount into
//     initialValue,    // string; selected on mount
//     agents,          // optional preloaded array of agent ids
//     fetchAgents,     // optional async () => string[]; defaults to /api/agents
//     onChange,        // optional (value) => void
//     inputAttrs,      // optional { id, 'data-key', placeholder, ... }
//   });
//   picker.getValue();
//   picker.setValue(v);
//   picker.setAgents([...]);
//   picker.destroy();
//
// The picker also surfaces a small warning line when the current value
// does not match any agent in the list (e.g. the saved default points
// at an agent that no longer exists).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RunwayAgentPicker = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  let listIdCounter = 0;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function defaultFetchAgents() {
    return fetch('/api/agents').then(r => r.ok ? r.json() : []);
  }

  function create(opts) {
    const options = opts || {};
    const host = options.host;
    if (!host) throw new Error('RunwayAgentPicker.create: host element is required');

    const listId = `runway-agent-list-${++listIdCounter}`;
    let agents = Array.isArray(options.agents) ? options.agents.slice() : [];
    const inputAttrs = options.inputAttrs || {};

    // Build the input + datalist + warning shell.
    const attrFrags = [];
    attrFrags.push(`type="text"`);
    attrFrags.push(`class="agent-picker-input"`);
    attrFrags.push(`list="${listId}"`);
    attrFrags.push(`autocomplete="off"`);
    attrFrags.push(`spellcheck="false"`);
    attrFrags.push(`placeholder="${esc(inputAttrs.placeholder || 'Type to search agents...')}"`);
    for (const [k, v] of Object.entries(inputAttrs)) {
      if (k === 'placeholder') continue;
      attrFrags.push(`${esc(k)}="${esc(v)}"`);
    }
    host.classList.add('agent-picker');
    host.innerHTML = `
      <input ${attrFrags.join(' ')}>
      <datalist id="${listId}"></datalist>
      <div class="agent-picker-warning" hidden></div>
    `;

    const input = host.querySelector('input');
    const datalist = host.querySelector('datalist');
    const warning = host.querySelector('.agent-picker-warning');

    function renderOptions() {
      datalist.innerHTML = agents
        .map(a => `<option value="${esc(a)}"></option>`)
        .join('');
    }

    function refreshWarning() {
      const v = input.value;
      // Empty value is allowed (means "use CLI default"); only warn when
      // the user has typed a non-empty value that does not match any
      // known agent. Agents list may legitimately be empty before the
      // fetch resolves; suppress the warning in that case.
      if (!v || agents.length === 0 || agents.includes(v)) {
        warning.hidden = true;
        warning.textContent = '';
        return;
      }
      warning.hidden = false;
      warning.textContent = `Unknown agent "${v}". It will be saved as-is but may not match a running agent.`;
    }

    function onInput() {
      refreshWarning();
      if (typeof options.onChange === 'function') {
        options.onChange(input.value);
      }
    }

    input.addEventListener('input', onInput);
    input.addEventListener('change', onInput);

    if (typeof options.initialValue === 'string') {
      input.value = options.initialValue;
    }

    // Initial agent load if none provided.
    if (!options.agents) {
      const fetcher = options.fetchAgents || defaultFetchAgents;
      Promise.resolve()
        .then(fetcher)
        .then(list => {
          if (Array.isArray(list)) {
            agents = list.slice();
            renderOptions();
            refreshWarning();
          }
        })
        .catch(() => { /* best-effort; leave datalist empty */ });
    } else {
      renderOptions();
    }
    refreshWarning();

    return {
      getValue() { return input.value; },
      setValue(v) { input.value = v == null ? '' : String(v); refreshWarning(); },
      setAgents(list) {
        agents = Array.isArray(list) ? list.slice() : [];
        renderOptions();
        refreshWarning();
      },
      element: input,
      destroy() {
        input.removeEventListener('input', onInput);
        input.removeEventListener('change', onInput);
        host.innerHTML = '';
        host.classList.remove('agent-picker');
      },
    };
  }

  return { create };
});
