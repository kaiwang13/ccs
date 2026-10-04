'use strict';
const acorn = require('acorn');

function children(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) out.push(...value.filter((v) => v && typeof v.type === 'string'));
    else if (value && typeof value.type === 'string') out.push(value);
  }
  return out;
}

function bindingNames(node, names = new Set()) {
  if (!node) return names;
  if (node.type === 'Identifier') names.add(node.name);
  else if (node.type === 'RestElement') bindingNames(node.argument, names);
  else if (node.type === 'AssignmentPattern') bindingNames(node.left, names);
  else if (node.type === 'ArrayPattern') node.elements.forEach((n) => bindingNames(n, names));
  else if (node.type === 'ObjectPattern') node.properties.forEach((n) => bindingNames(n.type === 'RestElement' ? n.argument : n.value, names));
  return names;
}

/** Free names in a declaration; property keys and function-local bindings are not dependencies. */
function references(root) {
  const free = new Set();
  function visit(node, scope, parent = null, key = '') {
    if (!node) return;
    if (/Function/.test(node.type)) {
      const local = new Set(scope);
      if (node.id) local.add(node.id.name);
      node.params.forEach((p) => bindingNames(p, local));
      function declarations(n) {
        if (n !== node.body && /Function/.test(n.type)) {
          if (n.type === 'FunctionDeclaration') local.add(n.id.name);
          return;
        }
        if (n.type === 'VariableDeclarator') bindingNames(n.id, local);
        if (n.type === 'CatchClause') bindingNames(n.param, local);
        for (const c of children(n)) declarations(c);
      }
      declarations(node.body);
      for (const p of node.params) if (p.type === 'AssignmentPattern') visit(p.right, local);
      visit(node.body, local, node, 'body');
      return;
    }
    if (node.type === 'Identifier') {
      if (parent && ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed)
        || (parent.type === 'Property' && key === 'key' && !parent.computed)
        || (parent.type === 'VariableDeclarator' && key === 'id')
        || (parent.type === 'CatchClause' && key === 'param')
        || /(?:Break|Continue|Labeled)Statement/.test(parent.type))) return;
      if (!scope.has(node.name)) free.add(node.name);
      return;
    }
    if (node.type === 'VariableDeclarator') { visit(node.init, scope, node, 'init'); return; }
    for (const [k, value] of Object.entries(node)) {
      if (Array.isArray(value)) {
        for (const c of value) if (c && c.type) visit(c, scope, node, k);
      } else if (value && value.type) visit(value, scope, node, k);
    }
  }
  visit(root, new Set());
  return free;
}

function parseModule(text) {
  const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  const bindings = new Map();
  const exports = new Map();
  const imports = new Map();
  for (let node of ast.body) {
    if (node.type === 'ExportNamedDeclaration') {
      for (const s of node.specifiers) exports.set(s.exported.name, s.local.name);
      if (!node.declaration) continue;
      node = node.declaration;
    }
    if (node.type === 'FunctionDeclaration') bindings.set(node.id.name, { node, code: text.slice(node.start, node.end) });
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) if (d.id.type === 'Identifier') bindings.set(d.id.name, { node: d, code: `var ${text.slice(d.start, d.end)};` });
    }
    if (node.type === 'ImportDeclaration') {
      for (const s of node.specifiers) imports.set(s.local.name, { node, imported: s.imported?.name, source: node.source.value });
    }
  }
  return { text, ast, bindings, exports, imports };
}

/** Resolve actual declarations from embedded bundle modules; never guess minified helper names. */
function dependencySource(binarySource, start, end, roots) {
  const before = binarySource.lastIndexOf('\0', start) + 1;
  const after = binarySource.indexOf('\0', end);
  const complete = after >= 0;
  const text = Buffer.from(binarySource.slice(before, complete ? after : end), 'latin1').toString('utf8');
  let primary;
  try { primary = parseModule(text); } catch { primary = parseModule(Buffer.from(binarySource.slice(start, end), 'latin1').toString('utf8')); }
  if (primary.imports.size === 0) return undefined; // Historical baseline fixtures use the explicitly documented legacy stubs.
  const parsed = new Map();
  const resolvedImports = new Map();
  const selected = new Map();
  const modules = new Map([[primary, '__decoder0']]);
  const visited = new Set();
  const imports = new Map();
  function select(mod, name, code) {
    if (!selected.has(mod)) selected.set(mod, new Map());
    selected.get(mod).set(name, code);
  }
  const globals = new Set(['process', 'Buffer', 'String', 'Math', 'Array', 'parseInt', 'JSON', 'undefined', 'Number', 'Boolean', 'Object', 'RegExp']);

  function importedModule(imp) {
    if (resolvedImports.has(imp.node)) return resolvedImports.get(imp.node);
    const expected = imp.node.specifiers.filter((s) => s.type === 'ImportSpecifier').map((s) => s.imported.name);
    const candidates = new Map();
    for (const m of binarySource.matchAll(/export\s*\{([^}]+)\}/g)) {
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop());
      if (!expected.every((n) => names.includes(n))) continue;
      const a = binarySource.lastIndexOf('\0', m.index) + 1;
      const b = binarySource.indexOf('\0', m.index);
      if (b < 0) continue;
      if (!parsed.has(a)) parsed.set(a, parseModule(Buffer.from(binarySource.slice(a, b), 'latin1').toString('utf8')));
      candidates.set(a, parsed.get(a));
    }
    if (candidates.size !== 1) throw new Error(`cannot resolve decoder import ${imp.source}: ${candidates.size} candidate modules`);
    const module = [...candidates.values()][0];
    resolvedImports.set(imp.node, module);
    return module;
  }

  function resolve(mod, name) {
    if (!modules.has(mod)) modules.set(mod, `__decoder${modules.size}`);
    const id = `${modules.get(mod)}:${name}`;
    if (visited.has(id) || globals.has(name)) return;
    visited.add(id);
    const binding = mod.bindings.get(name);
    const imp = mod.imports.get(name);
    if (!binding && imp?.source === 'buffer') { select(mod, name, `var ${name}=Buffer;`); return; }
    // Terminal attachment capabilities are supplied by the host. No attacher and a neutral
    // terminal reproduce the environment ccs gives its hosted process.
    if (binding && binding.code.includes('surfaceCapabilities.attacherCaps()')) { select(mod, name, `function ${name}(){return null;}`); return; }
    if (!binding && imp) {
      const properties = new Set();
      let bareUse = false;
      function propertyUses(node, parent = null) {
        if (node.type === 'Identifier' && node.name === name) {
          if (parent?.type === 'MemberExpression' && parent.object === node && !parent.computed) properties.add(parent.property.name);
          else bareUse = true;
        }
        for (const child of children(node)) propertyUses(child, node);
      }
      for (const key of (selected.get(mod) || new Map()).keys()) {
        const binding = mod.bindings.get(key);
        if (binding && references(binding.node).has(name)) propertyUses(binding.node);
      }
      if (!bareUse && properties.size === 1 && properties.has('TERM')) {
        select(mod, name, `var ${name}={TERM:'xterm-256color'};`);
        return;
      }
      if (!imp.imported) throw new Error(`unsupported decoder import ${name}`);
      const target = importedModule(imp);
      const local = target.exports.get(imp.imported);
      if (!local) throw new Error(`decoder export ${imp.imported} is missing`);
      resolve(target, local);
      if (!imports.has(mod)) imports.set(mod, []);
      imports.get(mod).push({ target, local, name });
      return;
    }
    if (!binding) throw new Error(`unresolved decoder dependency: ${name}`);
    // The bundle's environment object is an accessor into its terminal host. Its only use
    // here is TERM; the hosted pty uses xterm-256color, with no terminal dialect override.
    if (binding.node.type === 'VariableDeclarator' && binding.node.init?.type === 'CallExpression'
      && /(?:process\.env|terminal)/.test(binding.code)) {
      throw new Error(`unsupported decoder environment dependency: ${name}`);
    }
    select(mod, name, binding.code);
    for (const ref of references(binding.node)) if (ref !== name) {
      try { resolve(mod, ref); } catch (err) { err.message += ` (required by ${name})`; throw err; }
    }
  }
  for (const root of roots) resolve(primary, root);
  const output = [];
  const done = new Set();
  const active = new Set();
  function emit(mod) {
    if (done.has(mod)) return;
    if (active.has(mod)) throw new Error('cyclic decoder module imports');
    active.add(mod);
    for (const imp of imports.get(mod) || []) emit(imp.target);
    const aliases = (imports.get(mod) || []).map((imp) => `var ${imp.name}=${modules.get(imp.target)}.${imp.local};`);
    const declarations = [...selected.get(mod)].sort(([a], [b]) => (mod.bindings.get(a)?.node.start ?? -1) - (mod.bindings.get(b)?.node.start ?? -1));
    output.push(`var ${modules.get(mod)}=(()=>{\n${aliases.join('\n')}\n${declarations.map(([, code]) => code).join('\n')}\nreturn {${declarations.map(([name]) => name).join(',')}};\n})();`);
    active.delete(mod);
    done.add(mod);
  }
  emit(primary);
  for (const root of roots) output.push(`var ${root}=${modules.get(primary)}.${root};`);
  return output.join('\n');
}

module.exports = { parseModule, references, dependencySource };
