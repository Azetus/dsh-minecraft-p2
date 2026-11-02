import type { Cell } from '../model/types.ts'

type HeapItem = { cell: Cell; f: number; h: number; seq: number }

/** Binary min-heap keyed by f, then h, then insertion order. */
export class MinHeap {
  private readonly items: HeapItem[] = []
  private seq = 0

  get size(): number {
    return this.items.length
  }

  push(cell: Cell, f: number, h: number): void {
    const item: HeapItem = { cell, f, h, seq: this.seq++ }
    this.items.push(item)
    this.up(this.items.length - 1)
  }

  pop(): HeapItem | undefined {
    const first = this.items[0]
    const last = this.items.pop()
    if (first === undefined) return undefined
    if (last !== undefined && this.items.length > 0) {
      this.items[0] = last
      this.down(0)
    }
    return first
  }

  private less(a: HeapItem, b: HeapItem): boolean {
    if (a.f !== b.f) return a.f < b.f
    if (a.h !== b.h) return a.h < b.h
    return a.seq < b.seq
  }

  private up(index: number): void {
    let current = index
    while (current > 0) {
      const parent = (current - 1) >> 1
      if (!this.less(this.items[current]!, this.items[parent]!)) return
      const swap = this.items[current]!
      this.items[current] = this.items[parent]!
      this.items[parent] = swap
      current = parent
    }
  }

  private down(index: number): void {
    let current = index
    while (true) {
      const left = current * 2 + 1
      const right = left + 1
      let smallest = current
      if (left < this.items.length && this.less(this.items[left]!, this.items[smallest]!)) smallest = left
      if (right < this.items.length && this.less(this.items[right]!, this.items[smallest]!)) smallest = right
      if (smallest === current) return
      const swap = this.items[current]!
      this.items[current] = this.items[smallest]!
      this.items[smallest] = swap
      current = smallest
    }
  }
}
