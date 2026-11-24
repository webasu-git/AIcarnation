import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTickets } from './tickets.mjs'

test('券は 1 回だけ使える', () => {
  const tickets = createTickets()
  const t = tickets.issue()
  assert.match(t, /^[0-9a-f]{32}$/)
  assert.equal(tickets.redeem(t), true)
  assert.equal(tickets.redeem(t), false)
})

test('期限を過ぎた券・知らない券・形の違うものは使えない', () => {
  let now = 0
  const tickets = createTickets({ ttlMs: 1000, now: () => now })
  const t = tickets.issue()
  now = 1000
  assert.equal(tickets.redeem(t), false)
  assert.equal(tickets.redeem('0'.repeat(32)), false)
  assert.equal(tickets.redeem(undefined), false)
  assert.equal(tickets.redeem('x'), false)
})
