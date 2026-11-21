// A small QR Code encoder: byte mode, error correction level M, versions 1-12
// (up to 287 bytes), which covers any pairing address.

// Per version: [error correction codewords per block, blocks, data codewords
// per block, and optionally a second group's blocks and data codewords].
const BLOCKS: readonly (readonly number[])[] = [
  [10, 1, 16],
  [16, 1, 28],
  [26, 1, 44],
  [18, 2, 32],
  [24, 2, 43],
  [16, 4, 27],
  [18, 4, 31],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51],
  [22, 6, 36, 2, 37],
]

const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
]

const dataCodewords = (version: number): number => {
  const b = BLOCKS[version - 1] ?? []
  return (b[1] ?? 0) * (b[2] ?? 0) + (b[3] ?? 0) * (b[4] ?? 0)
}

const multiply = (x: number, y: number): number => {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }

  return z
}

const divisor = (degree: number): number[] => {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = multiply(result[j] ?? 0, root)
      if (j + 1 < degree) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0)
    }
    root = multiply(root, 2)
  }

  return result
}

const remainder = (data: readonly number[], div: readonly number[]): number[] => {
  const result = div.map(() => 0)
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0)
    result.push(0)
    div.forEach((coefficient, i) => {
      result[i] = (result[i] ?? 0) ^ multiply(coefficient, factor)
    })
  }

  return result
}

const codewordsOf = (bytes: Uint8Array, version: number): number[] => {
  const capacity = dataCodewords(version)
  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(4, 4)
  push(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)
  push(0, Math.min(4, capacity * 8 - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity * 8; pad ^= 0xec ^ 0x11) push(pad, 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0))
  }

  const [eccLength = 0, count1 = 0, size1 = 0, count2 = 0, size2 = 0] = BLOCKS[version - 1] ?? []
  const div = divisor(eccLength)
  const blocks: { data: number[]; ecc: number[] }[] = []
  let offset = 0
  for (const [count, size] of [
    [count1, size1],
    [count2, size2],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(offset, offset + size)
      offset += size
      blocks.push({ data: block, ecc: remainder(block, div) })
    }
  }
  const out: number[] = []
  for (let i = 0; i < Math.max(size1, size2); i++) {
    for (const block of blocks) {
      const byte = block.data[i]
      if (byte !== undefined) out.push(byte)
    }
  }
  for (let i = 0; i < eccLength; i++) {
    for (const block of blocks) out.push(block.ecc[i] ?? 0)
  }

  return out
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

const penaltyOf = (grid: readonly (readonly boolean[])[]): number => {
  const size = grid.length
  let penalty = 0
  let dark = 0
  const lines: boolean[][] = []
  for (let i = 0; i < size; i++) {
    lines.push([...(grid[i] ?? [])])
    lines.push(grid.map(row => row[i] === true))
  }
  for (const line of lines) {
    let run = 1
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++
      else {
        if (run >= 5) penalty += run - 2
        run = 1
      }
    }
    const text = line.map(cell => (cell ? '1' : '0')).join('')
    for (const pattern of ['10111010000', '00001011101']) {
      for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) penalty += 40
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = grid[y]?.[x] === true
      if (cell) dark++
      if (
        x + 1 < size &&
        y + 1 < size &&
        cell === grid[y]?.[x + 1] &&
        cell === grid[y + 1]?.[x] &&
        cell === grid[y + 1]?.[x + 1]
      ) {
        penalty += 3
      }
    }
  }

  return penalty + Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10
}

/**
 * The QR Code for `text` as rows of modules, true for dark, with no quiet
 * zone. Throws when the text is longer than version 12 holds.
 */
export const qrMatrix = (text: string): boolean[][] => {
  const bytes = new TextEncoder().encode(text)
  let version = 1
  while (version <= 12 && dataCodewords(version) - (version < 10 ? 2 : 3) < bytes.length) version++
  if (version > 12) throw new Error('text too long for a QR code')

  const size = 17 + 4 * version
  const base = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (grid: boolean[][], x: number, y: number, isDark: boolean): void => {
    const row = grid[y]
    const marks = reserved[y]
    if (row === undefined || marks === undefined || x < 0 || x >= size) return
    row[x] = isDark
    marks[x] = true
  }

  for (let i = 0; i < size; i++) {
    set(base, 6, i, i % 2 === 0)
    set(base, i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        set(base, cx + dx, cy + dy, distance !== 2 && distance !== 4)
      }
    }
  }
  const centers = ALIGNMENT[version - 1] ?? []
  const last = centers.length - 1
  centers.forEach((cx, i) => {
    centers.forEach((cy, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(base, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    })
  })

  const drawFormat = (grid: boolean[][], mask: number): void => {
    // Error correction level M is 0 in the format's two level bits.
    let rem = mask
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((mask << 10) | rem) ^ 0x5412
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0
    for (let i = 0; i <= 5; i++) set(grid, 8, i, bit(i))
    set(grid, 8, 7, bit(6))
    set(grid, 8, 8, bit(7))
    set(grid, 7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(grid, 14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(grid, size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(grid, 8, size - 15 + i, bit(i))
    set(grid, 8, size - 8, true)
  }
  drawFormat(base, 0)
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const isDark = ((bits >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(base, a, b, isDark)
      set(base, b, a, isDark)
    }
  }

  const codewords = codewordsOf(bytes, version)
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const isUpward = ((right + 1) & 2) === 0
        const y = isUpward ? size - 1 - vertical : vertical
        const row = base[y]
        if (row === undefined || reserved[y]?.[x] === true) continue
        if (index < codewords.length * 8) {
          row[x] = (((codewords[index >>> 3] ?? 0) >>> (7 - (index & 7))) & 1) !== 0
        }
        index++
      }
    }
  }

  let best: boolean[][] = base
  let bestPenalty = Infinity
  MASKS.forEach((mask, number) => {
    const grid = base.map((row, y) =>
      row.map((cell, x) => (reserved[y]?.[x] === true ? cell : cell !== mask(x, y))),
    )
    drawFormat(grid, number)
    const penalty = penaltyOf(grid)
    if (penalty < bestPenalty) {
      best = grid
      bestPenalty = penalty
    }
  })

  return best
}

/** The code as an SVG document, dark on white, with its quiet zone. */
export const qrSvg = (text: string): string => {
  const grid = qrMatrix(text)
  const quiet = 4
  const side = grid.length + quiet * 2
  let path = ''
  grid.forEach((row, y) => {
    row.forEach((isDark, x) => {
      if (isDark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`
    })
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${side * 6}" height="${side * 6}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}

/** The code as lines of half-block characters, for a terminal. */
export const qrLines = (text: string): string[] => {
  const grid = qrMatrix(text)
  const quiet = 2
  const side = grid.length + quiet * 2
  const at = (x: number, y: number): boolean => grid[y - quiet]?.[x - quiet] === true
  const lines: string[] = []
  for (let y = 0; y < side; y += 2) {
    let line = ''
    for (let x = 0; x < side; x++) {
      const top = at(x, y)
      const bottom = at(x, y + 1)
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█'
    }
    lines.push(line)
  }

  return lines
}
