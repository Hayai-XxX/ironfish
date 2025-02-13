/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IDatabaseEncoding } from './types'
import Serde, { IJSON, IJsonSerializable } from '../../serde'
import hexArray from 'hex-array'

export class JsonEncoding<T extends IJsonSerializable> implements IDatabaseEncoding<T> {
  serialize = (value: T): Buffer => Buffer.from(IJSON.stringify(value), 'utf8')
  deserialize = (buffer: Buffer): T => IJSON.parse(buffer.toString('utf8')) as T

  equals(): boolean {
    throw new Error('You should never use this')
  }
}

export class StringEncoding<TValues extends string = string>
  implements IDatabaseEncoding<TValues> {
  serialize = (value: TValues): Buffer => Buffer.from(value, 'utf8')
  deserialize = (buffer: Buffer): TValues => buffer.toString('utf8') as TValues

  equals(): boolean {
    throw new Error('You should never use this')
  }
}

export class BufferEncoding implements IDatabaseEncoding<Buffer> {
  serialize = (value: Buffer): Buffer => value
  deserialize = (buffer: Buffer): Buffer => buffer

  equals(): boolean {
    throw new Error('You should never use this')
  }
}

export class ArrayEncoding<T extends IJsonSerializable[]> extends JsonEncoding<T> {}

export class BufferArrayEncoding {
  serialize = (value: Buffer[]): Buffer => {
    const values = value.map((b) => new BufferToStringEncoding().serialize(b))
    return Buffer.from(JSON.stringify(values), 'utf8')
  }

  deserialize = (buffer: Buffer): Buffer[] => {
    const parsed = JSON.parse(buffer.toString('utf8')) as string[]
    return parsed.map((s) => new BufferToStringEncoding().deserialize(s))
  }

  equals(): boolean {
    throw new Error('You should never use this')
  }
}

export default class BufferToStringEncoding implements Serde<Buffer, string> {
  serialize(element: Buffer): string {
    return hexArray.toString(element)
  }

  deserialize(data: string): Buffer {
    return Buffer.from(hexArray.fromString(data))
  }

  equals(): boolean {
    throw new Error('You should never use this')
  }
}
