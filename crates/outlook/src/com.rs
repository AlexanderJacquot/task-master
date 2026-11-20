//! Late-bound COM automation (`IDispatch`), the one part of the crate with unsafe code.
//! Outlook's object model is reached by name, as a script would: no type library needed.

use std::mem::ManuallyDrop;

use windows::Win32::Foundation::{
    DISP_E_EXCEPTION, RPC_E_CHANGED_MODE, SYSTEMTIME, VARIANT_FALSE, VARIANT_TRUE,
};
use windows::Win32::Globalization::{DATE_SHORTDATE, GetDateFormatEx};
use windows::Win32::System::Com::{
    CLSCTX_LOCAL_SERVER, CLSIDFromProgID, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
    CoUninitialize, DISPATCH_FLAGS, DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT,
    DISPPARAMS, EXCEPINFO, IDispatch,
};
use windows::Win32::System::Ole::{DISPID_PROPERTYPUT, GetActiveObject};
use windows::Win32::System::Variant::{
    VARIANT, VT_BOOL, VT_BSTR, VT_DATE, VT_DISPATCH, VT_I2, VT_I4, VT_R8, VariantClear,
};
use windows_core::{BSTR, GUID, HRESULT, IUnknown, Interface, PCWSTR};

/// `LOCALE_USER_DEFAULT`: names are looked up as Outlook documents them.
const LOCALE: u32 = 0x0400;

/// COM for this thread (the multithreaded apartment: no message loop is needed for calls
/// to Outlook, which runs in its own process). Dropped last.
pub struct Apartment {
    owned: bool,
    /// COM was entered on this thread: not `Send`.
    _thread: std::marker::PhantomData<*const ()>,
}

impl Apartment {
    pub fn enter() -> Result<Self, String> {
        // SAFETY: no reserved pointer; balanced by `CoUninitialize` in `drop` when it
        // succeeded. A thread already in another apartment keeps it (RPC_E_CHANGED_MODE).
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr == RPC_E_CHANGED_MODE {
            return Ok(Self {
                owned: false,
                _thread: std::marker::PhantomData,
            });
        }
        hr.ok().map_err(|e| format!("cannot start COM: {e}"))?;
        Ok(Self {
            owned: true,
            _thread: std::marker::PhantomData,
        })
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.owned {
            // SAFETY: balances the successful `CoInitializeEx` of `enter` on this thread
            // (the struct is not `Send`, so it is dropped where it was made).
            unsafe { CoUninitialize() }
        }
    }
}

/// An argument to a call.
pub enum Arg<'a> {
    Str(&'a str),
    I4(i32),
    Bool(bool),
    Date(f64),
}

/// A value a call returned.
pub enum Value {
    Empty,
    Str(String),
    Int(i64),
    Bool(bool),
    /// OLE Automation date, or a double.
    Number(f64),
    Object(Dispatch),
}

impl Value {
    pub fn object(self, what: &str) -> Result<Dispatch, Error> {
        match self {
            Value::Object(d) => Ok(d),
            _ => Err(Error::other(format!("{what}: not an object"))),
        }
    }
    pub fn string(self) -> String {
        match self {
            Value::Str(s) => s,
            Value::Int(i) => i.to_string(),
            _ => String::new(),
        }
    }
    pub fn int(&self) -> i64 {
        match self {
            Value::Int(i) => *i,
            Value::Number(n) => *n as i64,
            Value::Bool(b) => i64::from(*b),
            _ => 0,
        }
    }
    pub fn bool(&self) -> bool {
        match self {
            Value::Bool(b) => *b,
            Value::Int(i) => *i != 0,
            _ => false,
        }
    }
    pub fn number(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            Value::Int(i) => Some(*i as f64),
            _ => None,
        }
    }
}

/// A failed call, with Outlook's own message when it gave one.
#[derive(Debug)]
pub struct Error {
    pub code: HRESULT,
    pub message: String,
}

impl Error {
    fn other(message: String) -> Self {
        Self {
            code: HRESULT(0x8000_4005_u32 as i32), // E_FAIL
            message,
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({:#010x})", self.message, self.code.0 as u32)
    }
}

/// An automation object.
#[derive(Clone)]
pub struct Dispatch(IDispatch);

impl Dispatch {
    /// The running instance of `prog_id`, if any.
    pub fn running(prog_id: &str) -> Result<Option<Self>, Error> {
        let clsid = clsid(prog_id)?;
        let mut unknown: Option<IUnknown> = None;
        // SAFETY: `clsid` and `unknown` outlive the call; the out pointer receives an
        // owned reference (or stays `None`).
        let found = unsafe { GetActiveObject(&clsid, None, &mut unknown) };
        match (found, unknown) {
            (Ok(()), Some(unknown)) => Ok(Some(Self(
                unknown.cast().map_err(|e| from_windows(&e, prog_id))?,
            ))),
            _ => Ok(None),
        }
    }

    /// The running instance, or a new one started in the background.
    pub fn start(prog_id: &str) -> Result<Self, Error> {
        let clsid = clsid(prog_id)?;
        // SAFETY: `clsid` outlives the call; no aggregation.
        let dispatch: IDispatch = unsafe { CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER) }
            .map_err(|e| from_windows(&e, prog_id))?;
        Ok(Self(dispatch))
    }

    pub fn get(&self, name: &str) -> Result<Value, Error> {
        self.invoke(name, DISPATCH_PROPERTYGET | DISPATCH_METHOD, &[], false)
    }

    pub fn get_with(&self, name: &str, args: &[Arg<'_>]) -> Result<Value, Error> {
        self.invoke(name, DISPATCH_PROPERTYGET | DISPATCH_METHOD, args, false)
    }

    pub fn call(&self, name: &str, args: &[Arg<'_>]) -> Result<Value, Error> {
        self.invoke(name, DISPATCH_METHOD | DISPATCH_PROPERTYGET, args, false)
    }

    pub fn put(&self, name: &str, value: Arg<'_>) -> Result<(), Error> {
        self.invoke(name, DISPATCH_PROPERTYPUT, &[value], true)
            .map(|_| ())
    }

    pub fn object(&self, name: &str) -> Result<Dispatch, Error> {
        self.get(name)?.object(name)
    }

    fn invoke(
        &self,
        name: &str,
        flags: DISPATCH_FLAGS,
        args: &[Arg<'_>],
        put: bool,
    ) -> Result<Value, Error> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let names = [PCWSTR(wide.as_ptr())];
        let mut id = 0i32;
        // SAFETY: one name, NUL-terminated and alive for the call; `id` receives one DISPID.
        unsafe {
            self.0
                .GetIDsOfNames(&GUID::zeroed(), names.as_ptr(), 1, LOCALE, &mut id)
        }
        .map_err(|e| from_windows(&e, name))?;

        // Arguments go in reverse order.
        let mut variants: Vec<VARIANT> = args.iter().rev().map(to_variant).collect();
        let mut named = [DISPID_PROPERTYPUT];
        let params = DISPPARAMS {
            rgvarg: if variants.is_empty() {
                std::ptr::null_mut()
            } else {
                variants.as_mut_ptr()
            },
            rgdispidNamedArgs: if put {
                named.as_mut_ptr()
            } else {
                std::ptr::null_mut()
            },
            cArgs: variants.len() as u32,
            cNamedArgs: u32::from(put),
        };
        let mut result = VARIANT::default();
        let mut info = EXCEPINFO::default();
        // SAFETY: every pointer refers to a local that outlives the call; the variants
        // were built by `to_variant` and are cleared below exactly once.
        let outcome = unsafe {
            self.0.Invoke(
                id,
                &GUID::zeroed(),
                LOCALE,
                flags,
                &params,
                Some(&mut result),
                Some(&mut info),
                None,
            )
        };
        for v in &mut variants {
            // SAFETY: an initialized VARIANT owned here (frees its BSTR).
            let _ = unsafe { VariantClear(v) };
        }
        let described = take_description(&mut info);
        if let Err(e) = outcome {
            let message = match described {
                Some(d) if e.code() == DISP_E_EXCEPTION => d,
                _ => e.message(),
            };
            return Err(Error {
                code: if e.code() == DISP_E_EXCEPTION && info.scode != 0 {
                    HRESULT(info.scode)
                } else {
                    e.code()
                },
                message: format!("{name}: {message}"),
            });
        }
        Ok(from_variant(result))
    }
}

/// Outlook's message from an exception, freeing its strings.
fn take_description(info: &mut EXCEPINFO) -> Option<String> {
    // SAFETY: the BSTRs of an EXCEPINFO are owned by the caller once Invoke returns (null
    // when unset); each is taken out of its ManuallyDrop exactly once and dropped.
    let (source, description, help) = unsafe {
        (
            ManuallyDrop::take(&mut info.bstrSource),
            ManuallyDrop::take(&mut info.bstrDescription),
            ManuallyDrop::take(&mut info.bstrHelpFile),
        )
    };
    drop((source, help));
    let text = description.to_string();
    (!text.trim().is_empty()).then(|| text.trim().to_owned())
}

fn clsid(prog_id: &str) -> Result<GUID, Error> {
    let wide: Vec<u16> = prog_id.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: a NUL-terminated wide string alive for the call.
    unsafe { CLSIDFromProgID(PCWSTR(wide.as_ptr())) }.map_err(|e| Error {
        code: e.code(),
        message: format!("{prog_id} is not installed"),
    })
}

fn from_windows(e: &windows_core::Error, what: &str) -> Error {
    Error {
        code: e.code(),
        message: format!("{what}: {}", e.message()),
    }
}

fn to_variant(arg: &Arg<'_>) -> VARIANT {
    let mut v = VARIANT::default();
    // SAFETY: `v` is a zeroed VARIANT owned here; each arm sets the tag and then the one
    // union member that tag names (a BSTR is handed over to the variant, which
    // `VariantClear` frees after the call).
    unsafe {
        let inner = &mut *v.Anonymous.Anonymous;
        match arg {
            Arg::Str(s) => {
                inner.vt = VT_BSTR;
                inner.Anonymous.bstrVal = ManuallyDrop::new(BSTR::from(*s));
            }
            Arg::I4(i) => {
                inner.vt = VT_I4;
                inner.Anonymous.lVal = *i;
            }
            Arg::Bool(b) => {
                inner.vt = VT_BOOL;
                inner.Anonymous.boolVal = if *b { VARIANT_TRUE } else { VARIANT_FALSE };
            }
            Arg::Date(d) => {
                inner.vt = VT_DATE;
                inner.Anonymous.date = *d;
            }
        }
    }
    v
}

fn from_variant(mut v: VARIANT) -> Value {
    // SAFETY: the tag says which member is set; objects and strings are copied (AddRef /
    // new BSTR) before `VariantClear` releases the variant's own references.
    let value = unsafe {
        let inner = &v.Anonymous.Anonymous;
        match inner.vt {
            VT_BSTR => Value::Str(inner.Anonymous.bstrVal.to_string()),
            VT_I4 => Value::Int(i64::from(inner.Anonymous.lVal)),
            VT_I2 => Value::Int(i64::from(inner.Anonymous.iVal)),
            VT_BOOL => Value::Bool(inner.Anonymous.boolVal.0 != 0),
            VT_DATE => Value::Number(inner.Anonymous.date),
            VT_R8 => Value::Number(inner.Anonymous.dblVal),
            VT_DISPATCH => match &*inner.Anonymous.pdispVal {
                Some(d) => Value::Object(Dispatch(d.clone())),
                None => Value::Empty,
            },
            _ => Value::Empty,
        }
    };
    // SAFETY: an initialized VARIANT returned by Invoke, owned here.
    let _ = unsafe { VariantClear(&mut v) };
    value
}

/// A date (wall time) written in the user's short date format, as Outlook's Jet filters
/// read dates.
pub fn short_date(year: u16, month: u16, day: u16) -> Result<String, String> {
    let date = SYSTEMTIME {
        wYear: year,
        wMonth: month,
        wDay: day,
        ..SYSTEMTIME::default()
    };
    let mut buf = [0u16; 80];
    // SAFETY: `date` and `buf` outlive the call; the user's locale and its default short
    // format (null name and format, no calendar).
    let len = unsafe {
        GetDateFormatEx(
            PCWSTR::null(),
            DATE_SHORTDATE,
            Some(&date),
            PCWSTR::null(),
            Some(&mut buf),
            PCWSTR::null(),
        )
    };
    if len <= 1 {
        return Err(format!("cannot format the date {year}-{month}-{day}"));
    }
    Ok(String::from_utf16_lossy(&buf[..len as usize - 1]))
}
