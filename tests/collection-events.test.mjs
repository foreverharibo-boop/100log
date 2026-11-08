import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollectionEventGate } from '../collection-events.js';
import { isVisibleChatMessage, recentWindowStart } from '../core.js';
import { messageSignature } from '../memory-engine.js';

const gate = () => createCollectionEventGate({ key: ctx => ctx.chatId,
    visible: isVisibleChatMessage, signature: messageSignature, windowStart: recentWindowStart });
const reply = mes => ({ mes, is_user: false });

test('loading a branch ignores copied receives and preserves the chat exactly', () => {
    const ctx = { chatId: 'branch', chat: [
        ...Array.from({ length: 2005 }, () => ({ ...reply('hidden'), is_hidden: true })),
        ...Array.from({ length: 34 }, (_, i) => reply(`copied ${i}`)),
    ] };
    const before = JSON.stringify(ctx);
    const events = gate(); events.loaded(ctx);
    for (let index = 0; index < ctx.chat.length; index++) assert.equal(events.received(ctx, index, 'normal'), false);
    assert.equal(JSON.stringify(ctx), before);
    ctx.chat.push(reply('new reply'));
    assert.equal(events.received(ctx, 2039, 'normal'), true);
    assert.equal(events.received(ctx, 2039, 'normal'), false);
});

test('switching rooms without a load notification still treats existing history as loaded', () => {
    const events = gate();
    events.loaded({ chatId: 'parent', chat: [reply('parent')] });
    const ctx = { chatId: 'branch', chat: [reply('copy'), reply('copy 2')] };
    assert.equal(events.received(ctx, 1, 'normal'), false);
    assert.equal(events.received(ctx, 0, 'normal'), false);
    ctx.chat.push(reply('new'));
    assert.equal(events.received(ctx, 2, 'normal'), true);
});

test('greetings, user messages and invalid indices do not start collection', () => {
    const events = gate();
    const ctx = { chatId: 'new', chat: [] }; events.loaded(ctx);
    ctx.chat.push(reply('greeting'));
    assert.equal(events.received(ctx, 0, 'first_message'), false);
    assert.equal(events.received(ctx, 0, 'normal'), false);
    ctx.chat.push({ mes: 'hi', is_user: true });
    assert.equal(events.received(ctx, 1, 'normal'), false);
    for (const index of [-1, undefined, 50, '1']) assert.equal(events.received(ctx, index, 'normal'), false);
    ctx.chat.push(reply('actual reply'));
    assert.equal(events.received(ctx, 2, 'normal'), true);
});

test('new swipes and continuations are collected, while metadata-only replays are ignored', () => {
    const events = gate();
    const ctx = { chatId: 'room', chat: [reply('old')] }; events.loaded(ctx);
    ctx.chat[0].extra = { branches: ['another branch'] };
    assert.equal(events.received(ctx, 0, 'normal'), false);
    ctx.chat[0].mes = 'alternate reply';
    assert.equal(events.received(ctx, 0, 'swipe'), true);
    ctx.chat[0].mes += ' continued';
    assert.equal(events.received(ctx, 0, 'continue'), true);
    events.loaded(ctx);
    assert.equal(events.received(ctx, 0, 'continue'), false);
});

test('an old replay outside the recent window cannot start collection', () => {
    const events = gate();
    const ctx = { chatId: 'room', chat: Array.from({ length: 200 }, (_, i) => reply(`old ${i}`)) };
    events.loaded(ctx);
    assert.equal(events.received(ctx, 0, 'normal'), false);
    ctx.chat[199].mes = 'new alternate';
    assert.equal(events.received(ctx, 199, 'swipe'), true);
});
