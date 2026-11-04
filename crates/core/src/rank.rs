//! Fractional ranks: string keys that sort between their neighbours, so moving an item
//! writes one row and never renumbers a list.
//!
//! Port of the `fractional-indexing` algorithm (base 62, variable-length integer part)
//! used by the TS side. Both implementations share `test-vectors/rank.json`.

use crate::error::{Error, Result};

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO: u8 = DIGITS[0];
const LAST: u8 = DIGITS[DIGITS.len() - 1];
/// The smallest integer part; a key starting with it can have nothing before it.
const SMALLEST_INTEGER: &str = "A00000000000000000000000000";

/// Returns a key that sorts strictly between `a` and `b` (`None` = open end).
pub fn key_between(a: Option<&str>, b: Option<&str>) -> Result<String> {
    if let Some(a) = a {
        validate(a)?;
    }
    if let Some(b) = b {
        validate(b)?;
    }
    if let (Some(a), Some(b)) = (a, b)
        && a >= b
    {
        return Err(Error::invalid(format!("rank '{a}' must sort before '{b}'")));
    }

    match (a, b) {
        (None, None) => Ok("a0".to_owned()),
        (None, Some(b)) => {
            let ib = integer_part(b)?;
            let fb = &b[ib.len()..];
            if ib == SMALLEST_INTEGER {
                return Ok(format!("{ib}{}", midpoint(b"", Some(fb.as_bytes()))?));
            }
            if ib.len() < b.len() {
                return Ok(ib.to_owned());
            }
            decrement_integer(ib)?.ok_or_else(|| Error::invalid("cannot rank before the first key"))
        }
        (Some(a), None) => {
            let ia = integer_part(a)?;
            let fa = &a[ia.len()..];
            match increment_integer(ia)? {
                Some(i) => Ok(i),
                None => Ok(format!("{ia}{}", midpoint(fa.as_bytes(), None)?)),
            }
        }
        (Some(a), Some(b)) => {
            let ia = integer_part(a)?;
            let fa = &a[ia.len()..];
            let ib = integer_part(b)?;
            let fb = &b[ib.len()..];
            if ia == ib {
                return Ok(format!(
                    "{ia}{}",
                    midpoint(fa.as_bytes(), Some(fb.as_bytes()))?
                ));
            }
            let i = increment_integer(ia)?
                .ok_or_else(|| Error::invalid("cannot rank after the last key"))?;
            if i.as_str() < b {
                Ok(i)
            } else {
                Ok(format!("{ia}{}", midpoint(fa.as_bytes(), None)?))
            }
        }
    }
}

/// Checks a key is well formed (used for ranks supplied by clients).
pub fn validate(key: &str) -> Result<()> {
    let bad = || Error::invalid(format!("invalid rank '{key}'"));
    if key == SMALLEST_INTEGER || !key.bytes().all(|c| digit(c).is_some()) {
        return Err(bad());
    }
    let int = integer_part(key)?;
    if key.len() > int.len() && key.as_bytes()[key.len() - 1] == ZERO {
        return Err(bad());
    }
    Ok(())
}

fn digit(c: u8) -> Option<usize> {
    DIGITS.iter().position(|&d| d == c)
}

/// Length of the integer part, encoded by its head character.
fn integer_length(head: u8) -> Result<usize> {
    match head {
        b'a'..=b'z' => Ok(usize::from(head - b'a') + 2),
        b'A'..=b'Z' => Ok(usize::from(b'Z' - head) + 2),
        _ => Err(Error::invalid(format!(
            "invalid rank head '{}'",
            head as char
        ))),
    }
}

fn integer_part(key: &str) -> Result<&str> {
    let head = *key
        .as_bytes()
        .first()
        .ok_or_else(|| Error::invalid("empty rank"))?;
    let len = integer_length(head)?;
    if len > key.len() {
        return Err(Error::invalid(format!("invalid rank '{key}'")));
    }
    Ok(&key[..len])
}

/// Digits strictly between `a` and `b` (`None` = 1.0). Neither may end in a zero digit.
fn midpoint(a: &[u8], b: Option<&[u8]>) -> Result<String> {
    if let Some(b) = b
        && !b.is_empty()
        && a >= b
    {
        return Err(Error::invalid("rank midpoint out of order"));
    }
    if a.last() == Some(&ZERO) || b.is_some_and(|b| b.last() == Some(&ZERO)) {
        return Err(Error::invalid("rank has a trailing zero"));
    }

    if let Some(b) = b.filter(|b| !b.is_empty()) {
        // Shared prefix (missing digits in `a` count as zero).
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(ZERO) == b[n] {
            n += 1;
        }
        if n > 0 {
            let rest = midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..]))?;
            return Ok(format!("{}{rest}", String::from_utf8_lossy(&b[..n])));
        }
    }

    let digit_a = a.first().map_or(Some(0), |&c| digit(c)).unwrap_or(0);
    let digit_b = match b.filter(|b| !b.is_empty()) {
        Some(b) => digit(b[0]).unwrap_or(0),
        None => DIGITS.len(),
    };
    if digit_b > digit_a + 1 {
        // Math.round(0.5 * (a + b)) in the JS original.
        Ok(char::from(DIGITS[(digit_a + digit_b).div_ceil(2)]).to_string())
    } else if let Some(b) = b.filter(|b| b.len() > 1) {
        Ok(char::from(b[0]).to_string())
    } else {
        let rest = midpoint(a.get(1..).unwrap_or(&[]), None)?;
        Ok(format!("{}{rest}", char::from(DIGITS[digit_a])))
    }
}

fn increment_integer(x: &str) -> Result<Option<String>> {
    let bytes = x.as_bytes();
    if integer_length(bytes[0])? != bytes.len() {
        return Err(Error::invalid(format!("invalid rank integer '{x}'")));
    }
    let head = bytes[0];
    let mut digs = bytes[1..].to_vec();
    let mut carry = true;
    for d in digs.iter_mut().rev() {
        let next = digit(*d).unwrap_or(0) + 1;
        if next == DIGITS.len() {
            *d = ZERO;
        } else {
            *d = DIGITS[next];
            carry = false;
            break;
        }
    }
    if carry {
        if head == b'Z' {
            return Ok(Some(format!("a{}", char::from(ZERO))));
        }
        if head == b'z' {
            return Ok(None);
        }
        let h = head + 1;
        if h > b'a' {
            digs.push(ZERO);
        } else {
            digs.pop();
        }
        return Ok(Some(join(h, &digs)));
    }
    Ok(Some(join(head, &digs)))
}

fn decrement_integer(x: &str) -> Result<Option<String>> {
    let bytes = x.as_bytes();
    if integer_length(bytes[0])? != bytes.len() {
        return Err(Error::invalid(format!("invalid rank integer '{x}'")));
    }
    let head = bytes[0];
    let mut digs = bytes[1..].to_vec();
    let mut borrow = true;
    for d in digs.iter_mut().rev() {
        match digit(*d).unwrap_or(0) {
            0 => *d = LAST,
            n => {
                *d = DIGITS[n - 1];
                borrow = false;
                break;
            }
        }
    }
    if borrow {
        if head == b'a' {
            return Ok(Some(format!("Z{}", char::from(LAST))));
        }
        if head == b'A' {
            return Ok(None);
        }
        let h = head - 1;
        if h < b'Z' {
            digs.push(LAST);
        } else {
            digs.pop();
        }
        return Ok(Some(join(h, &digs)));
    }
    Ok(Some(join(head, &digs)))
}

fn join(head: u8, digs: &[u8]) -> String {
    let mut s = String::with_capacity(digs.len() + 1);
    s.push(char::from(head));
    s.extend(digs.iter().map(|&d| char::from(d)));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vectors {
        cases: Vec<Case>,
    }

    #[derive(serde::Deserialize)]
    struct Case {
        a: Option<String>,
        b: Option<String>,
        expected: Option<String>,
        #[serde(default)]
        error: bool,
    }

    #[test]
    fn shared_vectors() {
        let vectors: Vectors =
            serde_json::from_str(include_str!("../test-vectors/rank.json")).unwrap();
        for case in vectors.cases {
            let got = key_between(case.a.as_deref(), case.b.as_deref());
            if case.error {
                assert!(
                    got.is_err(),
                    "{:?} {:?} should fail, got {got:?}",
                    case.a,
                    case.b
                );
            } else {
                assert_eq!(
                    got.unwrap(),
                    case.expected.unwrap(),
                    "key_between({:?}, {:?})",
                    case.a,
                    case.b
                );
            }
        }
    }

    /// Inserting at random positions keeps the list strictly ordered (plan M3: "dragging 50
    /// cards never reorders wrongly").
    #[test]
    fn random_inserts_stay_ordered() {
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move |n: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            usize::try_from(seed % n as u64).unwrap()
        };
        let mut keys: Vec<String> = Vec::new();
        for _ in 0..2_000 {
            let at = next(keys.len() + 1);
            let a = at.checked_sub(1).map(|i| keys[i].as_str());
            let b = keys.get(at).map(String::as_str);
            let key = key_between(a, b).unwrap();
            validate(&key).unwrap();
            keys.insert(at, key);
        }
        assert!(keys.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn appending_stays_short() {
        let mut last: Option<String> = None;
        for _ in 0..10_000 {
            last = Some(key_between(last.as_deref(), None).unwrap());
        }
        assert!(last.unwrap().len() <= 4);
    }
}
