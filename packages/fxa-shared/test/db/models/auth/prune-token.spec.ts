/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { expect } from 'chai';
import { StatsD } from 'hot-shots';
import { Knex } from 'knex';
import 'mocha';
import 'reflect-metadata';
import sinon from 'sinon';
import { PruneTokens, SessionToken } from '../../../../db/models/auth';
import { MetaData } from '../../../../db/models/auth/metadata';
import { uuidTransformer } from '../../../../db/transformers';
import { ILogger } from '../../../../log';
import { defaultOpts, testDatabaseSetup } from '../../helpers';

describe('PruneTokens', () => {
  const sandbox = sinon.createSandbox();
  const pruneInterval = 50;
  const maxJitter = 101;
  const statsd = sandbox.spy({
    increment: () => {},
  });
  const log = sandbox.spy({
    error: () => {},
  });
  let knex: Knex;
  let pruneTokens: PruneTokens;

  before(async () => {
    knex = await testDatabaseSetup({
      ...defaultOpts,
      auth: true,
      oauth: false,
      profile: false,
    });

    await MetaData.query().insert({
      name: 'sessionTokensPrunedUntil',
      value: '10',
    });

    await MetaData.query().insert({
      name: 'sessionTokensLastPrunedAt',
      value: '10',
    });
  });

  after(async () => {
    await knex.destroy();
  });

  beforeEach(async () => {
    pruneTokens = new PruneTokens(
      pruneInterval,
      statsd as unknown as StatsD,
      log as unknown as ILogger
    );
    await SessionToken.query().delete().execute();

    // Add a dummy token that was created 10s ago
    await insertToken(Date.now() - 1e4, Date.now() - 1e4);

    // Sanity check that a token does exist
    const sessionTokens1 = await SessionToken.query().select(
      'tokenId',
      'createdAt'
    );
    expect(sessionTokens1.length).to.equal(1);
  });

  afterEach(() => {
    pruneTokens.stop();
    sandbox.reset();
  });

  async function insertToken(createdAt: number, lastAccessTime: number) {
    await SessionToken.query().insert({
      tokenId: uuidTransformer.to('0123456789abcdef0123456789abcdef'),
      tokenData: uuidTransformer.to('0123456789abcdef0123456789abcdef'),
      uid: uuidTransformer.to('0123456789abcdef'),
      createdAt,
      lastAccessTime,
      uaBrowser: '',
      uaBrowserVersion: '',
      uaOS: '',
      uaOSVersion: '',
      uaDeviceType: '',
      uaFormFactor: '',
      authAt: 1,
      verificationMethod: 0,
      verifiedAt: 0,
      mustVerify: 0,
    });
  }

  it('Does not prune if maxAge is 0', async () => {
    pruneTokens.prune(0, 0);
    await new Promise((resolve) =>
      setTimeout(resolve, pruneInterval + maxJitter)
    );
    const sessionToken = await SessionToken.query().select('tokenId').first();
    expect(sessionToken).to.exist;
  });

  it('Prunes tokens', async () => {
    pruneTokens.prune(1, 1);
    await new Promise((resolve) =>
      setTimeout(resolve, pruneInterval + maxJitter)
    );

    // Check for the session token again
    const sessionTokens = await SessionToken.query().select(
      'tokenId',
      'createdAt'
    );

    expect(sessionTokens.length).to.equal(0);
    expect(statsd.increment.calledWith('PruneTokens.Start')).to.be.true;
    expect(statsd.increment.calledWith('PruneTokens.Error')).to.be.false;
    expect(statsd.increment.calledWith('PruneTokens.Complete')).to.be.true;
  });

  it('Ignores redundant prune requests', async () => {
    // Let pruner run
    pruneTokens.prune(1, 1);
    pruneTokens.prune(1, 1);
    pruneTokens.prune(1, 1);
    await new Promise((resolve) =>
      setTimeout(resolve, pruneInterval + maxJitter)
    );

    // Only the first prune should go through, and it should result in an increment
    // on PruneTokens.Start and PruneTokens.Complete
    sinon.assert.calledTwice(statsd.increment);
  });

  it('Stops pending prune', async () => {
    pruneTokens.prune(1, 1);
    const state1 = pruneTokens.state;
    const destroyed1 = pruneTokens.currentTimeoutId?._destroyed;

    pruneTokens.stop();
    const state2 = pruneTokens.state;
    const destroyed2 = pruneTokens.currentTimeoutId?._destroyed;

    expect(destroyed1).to.be.false;
    expect(destroyed2).to.be.true;
    expect(state1).to.equal('active');
    expect(state2).to.equal('open');
  });

  it('Handles error', async () => {
    // Causes error, will be reset on subsequent test
    PruneTokens.knex = null;

    await pruneTokens.prune(1, 1);

    expect(statsd.increment.calledWith('PruneTokens.Error')).to.be.true;
    expect(log.error.calledWith('TokenPruner')).to.be.true;
  });
});
