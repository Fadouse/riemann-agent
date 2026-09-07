/** Appended after the Python API prelude; no additional runtime/package assets. */
export const PYTHON_CODE_MODE_BOOTSTRAP = `
import ast as _riemann_ast
import builtins as _riemann_builtins
import types as _riemann_types
import sys as _riemann_sys
from IPython.display import display as _riemann_display

_riemann_bridge_module = _riemann_types.ModuleType("_riemann_bridge")
_riemann_sys.modules["_riemann_bridge"] = _riemann_bridge_module
_riemann_user_module = _riemann_types.ModuleType("_riemann_user")
riemann_code_state = {"store": {}, "namespace": _riemann_user_module.__dict__}

def _riemann_publish_bridge_types():
    # Serialize runtime definitions by reference, not their kernel globals.
    for name, value in list(globals().items()):
        if isinstance(value, (_riemann_types.FunctionType, type)) and getattr(value, "__module__", None) == "__main__":
            value.__module__ = "_riemann_bridge"
            setattr(_riemann_bridge_module, name, value)

def _riemann_snapshot_code_state(value):
    import dill, io
    _riemann_publish_bridge_types()
    namespace = value["namespace"]
    skipped, removed = [], {}
    try:
        buffer = io.BytesIO()
        try:
            dill.dump_module(buffer, module=_riemann_user_module, refimported=True)
        except Exception:
            # Remove unsupported data before checking functions that reference it.
            for name, item in sorted(list(namespace.items()), key=lambda entry: callable(entry[1])):
                try:
                    dill.dumps(item)
                except Exception as error:
                    removed[name] = namespace.pop(name)
                    skipped.append({"name": f"persist.{name}", "reason": f"{type(error).__name__}: {error}"})
            buffer = io.BytesIO()
            dill.dump_module(buffer, module=_riemann_user_module, refimported=True)
        return {"store": value["store"], "namespace": buffer.getvalue()}, skipped
    finally:
        namespace.update(removed)

def _riemann_restore_code_state(value):
    import dill, io
    dill.load_module(io.BytesIO(value["namespace"]), module=_riemann_user_module)
    return {"store": value["store"], "namespace": _riemann_user_module.__dict__}

def store(key, value):
    if not isinstance(key, str) or not key:
        raise ValueError("store key must be a non-empty string")
    encoded = _json.dumps(value, allow_nan=False)
    if len(encoded.encode("utf-8")) > 1048576:
        raise ValueError("store values are limited to 1 MiB; use an artifact for larger data")
    riemann_code_state["store"][key] = _json.loads(encoded)

def load(key, default=None):
    value = riemann_code_state["store"].get(key, default)
    return _json.loads(_json.dumps(value, allow_nan=False))

async def _riemann_exec_source(source, persist=False):
    api = {name: globals()[name] for name in _RIEMANN_PROTECTED if name in globals() and not name.startswith("_")}
    api.update({"__builtins__": _riemann_builtins.__dict__, "__name__": "_riemann_user" if persist else "__main__", "store": store, "load": load, "display": _riemann_display})
    namespace = riemann_code_state["namespace"] if persist else {}
    namespace.update(api)
    before = _asyncio.all_tasks()
    try:
        code = compile(source, "<python-cell>", "exec", flags=_riemann_ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        result = eval(code, namespace)
        if _inspect.isawaitable(result):
            await result
    finally:
        pending = _asyncio.all_tasks() - before
        for task in pending:
            task.cancel()
        if pending:
            await _asyncio.gather(*pending, return_exceptions=True)
        if persist:
            # Keep one dictionary so functions retain live cross-cell globals.
            # Runtime API objects are reinstalled, not serialized in checkpoints.
            for name in api:
                if name not in {"__name__", "__builtins__"}:
                    namespace.pop(name, None)

_RIEMANN_PROTECTED.update({"store", "load"})
_riemann_publish_bridge_types()
`;
