import { describe, expect, it } from 'vitest'

import { formatTarget, parseTargetArgs, parseTargetFields } from '../src/bridge/target.ts'

describe('mc target parsing', () => {
  it('accepts host:port and separate host/port arguments', () => {
    expect(parseTargetArgs(['127.0.0.1:25575'])).toEqual({
      target: { host: '127.0.0.1', port: 25575 },
    })
    expect(parseTargetArgs(['localhost', '25575'])).toEqual({
      target: { host: 'localhost', port: 25575 },
    })
  })

  it('brackets IPv6 hosts in command text', () => {
    expect(parseTargetArgs(['[::1]:25575'])).toEqual({
      target: { host: '::1', port: 25575 },
    })
    expect(formatTarget({ host: '::1', port: 25575 })).toBe('[::1]:25575')
    expect(formatTarget({ host: '127.0.0.1', port: 25575 })).toBe('127.0.0.1:25575')
  })

  it('accepts separate tool fields, including a bracketed IPv6 host', () => {
    expect(parseTargetFields('127.0.0.1', 25575)).toEqual({
      target: { host: '127.0.0.1', port: 25575 },
    })
    expect(parseTargetFields('[::1]', '25575')).toEqual({
      target: { host: '::1', port: 25575 },
    })
  })

  it('rejects missing or malformed targets', () => {
    expect(parseTargetArgs([])).toHaveProperty('error')
    expect(parseTargetArgs(['localhost'])).toHaveProperty('error')
    expect(parseTargetArgs(['127.0.0.1:0'])).toHaveProperty('error')
    expect(parseTargetArgs(['127.0.0.1:65536'])).toHaveProperty('error')
    expect(parseTargetArgs(['http://127.0.0.1:25575'])).toHaveProperty('error')
    expect(parseTargetArgs(['::1:25575'])).toHaveProperty('error')
    expect(parseTargetFields('', 25575)).toHaveProperty('error')
    expect(parseTargetFields('127.0.0.1', 0)).toHaveProperty('error')
  })
})
