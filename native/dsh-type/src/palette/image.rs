//! Copied images, kept as PNG whatever the system hands over: the page shows PNG as is, and the
//! same bytes going back to the clipboard come back identical, so a copy made from the history is
//! recognised instead of stored twice.

/// Largest PNG kept; a bigger picture is a document, not a snippet.
pub const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
/// Largest picture decoded or encoded (a 8K screen is 33 M pixels).
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_PIXELS: u64 = 40_000_000;

const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

/// The PNG at the start of `bytes`, cut after its last chunk (a clipboard block is often padded),
/// and its size in pixels. None when it is not a whole PNG.
pub fn png(bytes: &[u8]) -> Option<(&[u8], u32, u32)> {
    if bytes.get(..8)? != SIGNATURE || bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    let (width, height) = (be32(bytes, 16)?, be32(bytes, 20)?);
    if width == 0 || height == 0 {
        return None;
    }
    let mut at = 8usize;
    loop {
        let length = be32(bytes, at)? as usize;
        let kind = bytes.get(at + 4..at + 8)?;
        // Length, type, data, checksum.
        let end = at.checked_add(12)?.checked_add(length)?;
        if end > bytes.len() {
            return None;
        }
        if kind == b"IEND" {
            return Some((&bytes[..end], width, height));
        }
        at = end;
    }
}

/// A device-independent bitmap (CF_DIB: the header, maybe colour masks, the pixels) as PNG.
/// Takes the 24 and 32 bit pictures programs put there; others are left out.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn dib_to_png(dib: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let header = le32(dib, 0)? as usize;
    if header < 40 {
        return None;
    }
    let width = le32(dib, 4)? as i32;
    let height = le32(dib, 8)? as i32;
    let bits = le16(dib, 14)?;
    let compression = le32(dib, 16)?;
    let colours = le32(dib, 32)? as usize;
    // BI_RGB, or BI_BITFIELDS with the usual masks (which are all that programs write).
    if width <= 0 || height == 0 || !matches!(bits, 24 | 32) || !matches!(compression, 0 | 3) {
        return None;
    }
    let (w, h) = (width as u32, height.unsigned_abs());
    if w as u64 * h as u64 > MAX_PIXELS {
        return None;
    }
    let masks = if compression == 3 && header == 40 { 12 } else { 0 };
    let start = header + masks + colours * 4;
    let stride = (w as usize * bits as usize).div_ceil(32) * 4;
    let pixels = dib.get(start..start.checked_add(stride.checked_mul(h as usize)?)?)?;
    let step = bits as usize / 8;
    let mut rgba = Vec::with_capacity(w as usize * h as usize * 4);
    for y in 0..h as usize {
        // A positive height is stored bottom up.
        let line = if height > 0 { h as usize - 1 - y } else { y };
        let row = &pixels[line * stride..line * stride + w as usize * step];
        for px in row.chunks_exact(step) {
            rgba.extend_from_slice(&[px[2], px[1], px[0], if step == 4 { px[3] } else { 255 }]);
        }
    }
    // Most programs leave the fourth byte at zero: that is no alpha, not a clear picture.
    if step == 4 && rgba.chunks_exact(4).all(|px| px[3] == 0) {
        rgba.chunks_exact_mut(4).for_each(|px| px[3] = 255);
    }
    encode(&rgba, w, h).map(|png| (png, w, h))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn encode(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    encoder.write_header().ok()?.write_image_data(rgba).ok()?;
    Some(out)
}

/// A PNG as a 32 bit bottom-up DIB, for the programs that only paste CF_DIB.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn png_to_dib(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = png::Decoder::new_with_limits(std::io::Cursor::new(bytes), png::Limits { bytes: MAX_PIXELS as usize * 4 + (1 << 20) });
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().ok()?;
    let mut buffer = vec![0; reader.output_buffer_size()?];
    let frame = reader.next_frame(&mut buffer).ok()?;
    let (w, h) = (frame.width as usize, frame.height as usize);
    let step = match frame.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return None,
    };
    let mut dib = Vec::with_capacity(40 + w * h * 4);
    for value in [40u32, w as u32, h as u32] {
        dib.extend_from_slice(&value.to_le_bytes());
    }
    dib.extend_from_slice(&1u16.to_le_bytes());
    dib.extend_from_slice(&32u16.to_le_bytes());
    dib.extend_from_slice(&0u32.to_le_bytes());
    dib.extend_from_slice(&((w * h * 4) as u32).to_le_bytes());
    dib.extend_from_slice(&[0; 16]);
    for y in (0..h).rev() {
        for px in buffer[y * frame.line_size..y * frame.line_size + w * step].chunks_exact(step) {
            let (r, g, b, a) = match step {
                1 => (px[0], px[0], px[0], 255),
                2 => (px[0], px[0], px[0], px[1]),
                3 => (px[0], px[1], px[2], 255),
                _ => (px[0], px[1], px[2], px[3]),
            };
            dib.extend_from_slice(&[b, g, r, a]);
        }
    }
    Some(dib)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dib(width: i32, height: i32, bits: u16, pixels: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for value in [40u32, width as u32, height as u32] {
            out.extend_from_slice(&value.to_le_bytes());
        }
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&bits.to_le_bytes());
        out.extend_from_slice(&[0; 24]);
        out.extend_from_slice(pixels);
        out
    }

    #[test]
    fn a_padded_png_is_cut_after_its_end_and_measured() {
        let (png, _, _) = dib_to_png(&dib(1, 1, 32, &[1, 2, 3, 0])).unwrap();
        let mut padded = png.clone();
        padded.extend_from_slice(&[0; 13]);
        let (cut, w, h) = super::png(&padded).unwrap();
        assert_eq!((cut, w, h), (&png[..], 1, 1));
        assert!(super::png(&png[..png.len() - 1]).is_none(), "a truncated PNG is not one");
        assert!(super::png(b"GIF89a....").is_none());
    }

    #[test]
    fn a_bottom_up_dib_becomes_the_same_picture_and_back() {
        // 2×2, 24 bit, rows padded to 8 bytes, bottom row first: blue, green / red, white.
        let pixels = [255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0];
        let (png, w, h) = dib_to_png(&dib(2, 2, 24, &pixels)).unwrap();
        assert_eq!((w, h), (2, 2));
        let back = png_to_dib(&png).unwrap();
        assert_eq!(le32(&back, 4), Some(2));
        // Bottom row first again, as BGRA: blue, green, then red, white.
        assert_eq!(&back[40..], &[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    }

    #[test]
    fn unsupported_or_short_bitmaps_are_left_out() {
        assert!(dib_to_png(&dib(2, 2, 8, &[0; 8])).is_none());
        assert!(dib_to_png(&dib(2, 2, 32, &[0; 8])).is_none(), "fewer pixels than the header says");
    }
}
