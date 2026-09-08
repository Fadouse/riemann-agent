/** Appended after the Python API prelude. User cells never own the persistent globals. */
export const PYTHON_CODE_MODE_BOOTSTRAP = `
import ast as _riemann_ast
import builtins as _riemann_builtins
import types as _riemann_types
import sys as _riemann_sys
import contextvars as _riemann_contextvars
import traceback as _riemann_traceback
from IPython.display import display as _riemann_display

_riemann_bridge_module = _riemann_types.ModuleType("_riemann_bridge")
_riemann_sys.modules["_riemann_bridge"] = _riemann_bridge_module
_riemann_user_module = _riemann_types.ModuleType("_riemann_user")
_riemann_sys.modules["_riemann_user"] = _riemann_user_module

class _PersistentState:
    def __setattr__(self, name, value):
        if isinstance(value, _riemann_types.FunctionType) and value.__globals__ is not _riemann_user_module.__dict__:
            original = value
            value = _riemann_types.FunctionType(original.__code__, _riemann_user_module.__dict__, original.__name__, original.__defaults__, original.__closure__)
            value.__kwdefaults__ = original.__kwdefaults__
            value.__annotations__ = dict(original.__annotations__)
            value.__dict__.update(original.__dict__)
            value.__module__ = "_riemann_user"
            value.__qualname__ = original.__name__
        self.__dict__[name] = value
        _riemann_refresh_functions(self)

    def __delattr__(self, name):
        if name not in self.__dict__:
            raise AttributeError(name)
        del self.__dict__[name]
        _riemann_refresh_functions(self)

    def __call__(self, function):
        if not isinstance(function, _riemann_types.FunctionType):
            raise TypeError("@persist requires a Python function")
        setattr(self, function.__name__, function)
        return getattr(self, function.__name__)

def _riemann_refresh_functions(state):
    namespace = _riemann_user_module.__dict__
    for name, value in list(namespace.items()):
        if isinstance(value, _riemann_types.FunctionType) and value.__globals__ is namespace:
            del namespace[name]
    for value in vars(state).values():
        if isinstance(value, _riemann_types.FunctionType) and value.__globals__ is namespace:
            namespace[value.__name__] = value

persist = _PersistentState()
riemann_code_state = {"version": 2}

def _riemann_publish_bridge_types():
    for name, value in list(globals().items()):
        if isinstance(value, (_riemann_types.FunctionType, type)) and getattr(value, "__module__", None) == "__main__":
            value.__module__ = "_riemann_bridge"
            setattr(_riemann_bridge_module, name, value)

def _riemann_snapshot_code_state(value):
    import dill, io
    _riemann_publish_bridge_types()
    skipped, removed, api = [], {}, {}
    try:
        namespace = _riemann_user_module.__dict__
        for name, item in list(namespace.items()):
            if name not in {"persist", "__name__", "__builtins__"} and not (isinstance(item, _riemann_types.FunctionType) and item.__globals__ is namespace):
                api[name] = namespace.pop(name)
        buffer = io.BytesIO()
        try:
            dill.dump_module(buffer, module=_riemann_user_module, refimported=True)
        except Exception:
            for name, item in sorted(list(vars(persist).items()), key=lambda entry: callable(entry[1])):
                try:
                    dill.dumps(item)
                except Exception as error:
                    removed[name] = item
                    delattr(persist, name)
                    skipped.append({"name": f"persist.{name}", "reason": f"{type(error).__name__}: {error}"})
            buffer = io.BytesIO()
            dill.dump_module(buffer, module=_riemann_user_module, refimported=True)
        return {"version": 2, "namespace": buffer.getvalue()}, skipped
    finally:
        _riemann_user_module.__dict__.update(api)
        for name, item in removed.items():
            setattr(persist, name, item)

def _riemann_restore_code_state(value):
    import dill, io
    if value.get("version") == 2:
        dill.load_module(io.BytesIO(value["namespace"]), module=_riemann_user_module)
        restored = _riemann_user_module.__dict__.get("persist")
        if restored is not None and restored is not persist:
            persist.__dict__.update(vars(restored))
    elif value.get("version") in (None, 1):
        legacy_namespace = value.get("namespace", {})
        if isinstance(legacy_namespace, bytes):
            legacy_module = _riemann_types.ModuleType("_riemann_user")
            dill.load_module(io.BytesIO(legacy_namespace), module=legacy_module)
            legacy_namespace = legacy_module.__dict__
        for name, item in legacy_namespace.items():
            if not name.startswith("_") and name not in _RIEMANN_PROTECTED:
                setattr(persist, name, item)
        legacy_store = value.get("store", {})
        if legacy_store:
            _riemann_display({"application/vnd.riemann.migration+json": legacy_store}, raw=True)
    else:
        raise ValueError("Unsupported persistent state version; original checkpoint retained")
    _riemann_user_module.__dict__["persist"] = persist
    _riemann_refresh_functions(persist)
    return {"version": 2}

_riemann_owned_tasks = _riemann_contextvars.ContextVar("riemann_owned_tasks", default=None)
_riemann_cells = {}
_riemann_cancelled_cells = set()

def _riemann_install_task_factory(loop):
    previous = loop.get_task_factory()
    if getattr(previous, "_riemann_owned", False):
        return
    def factory(loop, coroutine, **kwargs):
        task = previous(loop, coroutine, **kwargs) if previous else _asyncio.Task(coroutine, loop=loop, **kwargs)
        context = kwargs.get("context")
        owned = context.get(_riemann_owned_tasks) if context is not None else _riemann_owned_tasks.get()
        if owned is not None:
            owned.add(task)
            task.add_done_callback(owned.discard)
        return task
    factory._riemann_owned = True
    loop.set_task_factory(factory)

async def _riemann_exec_source(source):
    api = {name: globals()[name] for name in _RIEMANN_PROTECTED if name in globals() and not name.startswith("_")}
    api.update({"__builtins__": _riemann_builtins.__dict__, "__name__": "__main__", "persist": persist, "print": _riemann_print, "display": _riemann_display})
    _riemann_user_module.__dict__.update({**api, "__name__": "_riemann_user"})
    namespace = dict(api)
    _riemann_install_task_factory(_asyncio.get_running_loop())
    owned = set()
    token = _riemann_owned_tasks.set(owned)
    try:
        code = compile(source, "<python-cell>", "exec", flags=_riemann_ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        result = eval(code, namespace)
        if _inspect.isawaitable(result):
            await result
    finally:
        try:
            while owned:
                pending = list(owned)
                for task in pending:
                    task.cancel()
                await _asyncio.gather(*pending, return_exceptions=True)
        finally:
            _riemann_owned_tasks.reset(token)

async def yield_control():
    _riemann_sys.stdout.flush()
    _riemann_sys.stderr.flush()
    _riemann_display({"application/vnd.riemann.cell+json": {"event": "yield"}}, raw=True)
    await _asyncio.sleep(0)

def _riemann_install_cell_dispatch():
    kernel = get_ipython().kernel
    loop = _asyncio.get_running_loop()
    _riemann_install_task_factory(loop)
    _install_control_comm_handlers()
    def cancel_cell(comm, message):
        target = message.get("content", {}).get("data", {}).get("id")
        def cancel():
            task = _riemann_cells.get(target)
            if task is not None:
                task.cancel()
            elif isinstance(target, str):
                _riemann_cancelled_cells.add(target)
        loop.call_soon_threadsafe(cancel)
        comm.close()
    kernel.comm_manager.register_target("riemann.cells", cancel_cell)

def _riemann_start_cell(source):
    cell_id = get_ipython().kernel.get_parent("shell")["header"]["msg_id"]
    loop = _asyncio.get_running_loop()
    def finished(task):
        event = {"event": "completed", "status": "ok"}
        if task.cancelled():
            event["status"] = "cancelled"
            error = None
        else:
            error = task.exception()
        if error is not None:
            event["status"] = "error"
            event["error"] = {"ename": type(error).__name__, "evalue": str(error), "traceback": _riemann_traceback.format_exception(type(error), error, error.__traceback__)}
            if isinstance(error, RiemannError):
                event["error"].update({"code": error.code, "operation": error.operation or "riemann", "recovery": error.recovery, "details": error.details})
        _riemann_sys.stdout.flush()
        _riemann_sys.stderr.flush()
        _riemann_display({"application/vnd.riemann.cell+json": event}, raw=True)
        _riemann_cells.pop(cell_id, None)
    # ipykernel's parent headers are ContextVars inherited by this task, so
    # native streams, rich displays and host calls retain their originating cell.
    task = loop.create_task(_riemann_exec_source(source))
    _riemann_cells[cell_id] = task
    # A done callback also reports cancellation before the coroutine's first step.
    task.add_done_callback(finished)
    if cell_id in _riemann_cancelled_cells:
        _riemann_cancelled_cells.discard(cell_id)
        task.cancel()

_RIEMANN_PROTECTED.update({"persist", "refs", "yield_control"})
_riemann_user_module.__dict__["persist"] = persist
_riemann_publish_bridge_types()
`;
