/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect } from 'chai';
import * as uuid from 'uuid';
import {
  CommonPiiActions,
  DepthFilter,
  TRUNCATED,
  FILTERED,
  PiiRegexFilter,
} from '../../sentry/pii-filter-actions';

describe('pii-filter-actions', () => {
  describe('DepthFilter', () => {
    it('only truncates objects', () => {
      const filter = new DepthFilter(1);

      expect(filter.execute('foo', 1)).to.equal('foo');
      expect(filter.execute(null, 1)).to.equal(null);
    });

    it('truncates objects when depth is greater than or equal to max depth', () => {
      const filter = new DepthFilter(1);
      expect(filter.execute({ foo: 'bar' }, 1)).to.deep.equal({
        foo: TRUNCATED,
      });
    });

    it('does not truncate if depth is less than max depth ', () => {
      const filter = new DepthFilter(1);
      expect(filter.execute({ foo: 'bar' }, 0)).to.deep.equal({ foo: 'bar' });
    });
  });

  describe('PiiRegexFilter', () => {
    it('filters string', () => {
      const filter = new PiiRegexFilter(/foo/gi, 'values', '[BAR]');
      const value = filter.execute('test foo regex filter');
      expect(value).to.equal('test [BAR] regex filter');
    });

    it('filters object value', () => {
      const filter1 = new PiiRegexFilter(/foo/gi, 'both', '[BAR]');
      const filter2 = new PiiRegexFilter(/foo/gi, 'values', '[BAR]');

      const value1 = filter1.execute({
        item: 'test foo regex filter',
      });
      const value2 = filter2.execute({
        item: 'test foo regex filter',
      });

      expect(value1.item).to.equal('test [BAR] regex filter');
      expect(value2.item).to.equal('test [BAR] regex filter');
    });

    it('filters object key', () => {
      const filter = new PiiRegexFilter(/foo/gi, 'keys', '[BAR]');

      const value = filter.execute({
        foo: 'test foo regex filter',
      });

      expect(value.foo).to.equal('[BAR]');
    });

    describe('checksOn', () => {
      it('checks only on values', () => {
        const filter = new PiiRegexFilter(/foo/gi, 'values', '[BAR]');
        const value = filter.execute({
          foo: 'test foo regex filter',
          bar: 'test foo regex filter',
        });
        expect(value.foo).to.equal('test [BAR] regex filter');
        expect(value.bar).to.equal('test [BAR] regex filter');
      });

      it('checks only on keys', () => {
        const filter = new PiiRegexFilter(/foo/gi, 'keys', '[BAR]');
        const value = filter.execute({
          foo: 'test foo regex filter',
          bar: 'test foo regex filter',
        });
        expect(value.foo).to.equal('[BAR]');
        expect(value.bar).to.equal('test foo regex filter');
      });

      it('checks on keys and values', () => {
        const filter = new PiiRegexFilter(/foo/gi, 'both', '[BAR]');
        const value = filter.execute({
          foo: 'test foo regex filter',
          bar: 'test foo regex filter',
        });
        expect(value.foo).to.equal('[BAR]');
        expect(value.bar).to.equal('test [BAR] regex filter');
      });
    });
  });

  describe('CommonPiiActions', () => {
    it('filters emails', () => {
      const result = CommonPiiActions.emailValues.execute({
        foo: 'email: test@123.com -- 123@test.com --',
        bar: '123',
      });

      expect(result).to.deep.equal({
        foo: `email: ${FILTERED} -- ${FILTERED} --`,
        bar: '123',
      });
    });

    it('filters email in url', () => {
      const result = CommonPiiActions.emailValues.execute(
        'http://foo.bar/?email=foxkey@mozilla.com&key=1'
      );
      expect(result).to.equal(`http://foo.bar/?${FILTERED}&key=1`);
    });

    it('filters username / password from url', () => {
      const result = CommonPiiActions.urlUsernamePassword.execute(
        'http://me:wut@foo.bar/'
      );
      expect(result).to.equal(`http://${FILTERED}:${FILTERED}@foo.bar/`);
    });

    it('ipv6 values', () => {
      const result = CommonPiiActions.ipV6Values.execute({
        foo: 'ipv6: 2001:0db8:85a3:0000:0000:8a2e:0370:7334 -- FE80:0000:0000:0000:0202:B3FF:FE1E:8329 --',
        bar: '123',
      });
      expect(result).to.deep.equal({
        foo: `ipv6: ${FILTERED} -- ${FILTERED} --`,
        bar: '123',
      });
    });

    it('ipv4 values', () => {
      const result = CommonPiiActions.ipV4Values.execute({
        foo: '-- 127.0.0.1 -- 10.0.0.1 -- ',
        bar: '1.2.3',
      });
      expect(result).to.deep.equal({
        foo: `-- ${FILTERED} -- ${FILTERED} -- `,
        bar: '1.2.3',
      });
    });

    it('filters pii keys', () => {
      const result = CommonPiiActions.piiKeys.execute({
        'oidc-test': 'foo',
        'OIDC-TEST': 'foo',
        'remote-groups': 'foo',
        'REMOTE-GROUPS': 'foo',
        email_address: 'foo',
        email: 'foo',
        EmailAddress: 'foo',
        ip: 'foo',
        ip_addr: 'foo',
        ip_address: 'foo',
        IpAddress: 'foo',
        uid: 'foo',
        user: 'foo',
        username: 'foo',
        user_name: 'foo',
        UserName: 'foo',
        userid: 'foo',
        UserId: 'foo',
        user_id: 'foo',
        bar: '123',
      });

      expect(result).to.deep.equal({
        'oidc-test': FILTERED,
        'OIDC-TEST': FILTERED,
        'remote-groups': FILTERED,
        'REMOTE-GROUPS': FILTERED,
        email: FILTERED,
        email_address: FILTERED,
        EmailAddress: FILTERED,
        ip: FILTERED,
        ip_addr: FILTERED,
        ip_address: FILTERED,
        IpAddress: FILTERED,
        uid: FILTERED,
        user: FILTERED,
        username: FILTERED,
        user_name: FILTERED,
        UserName: FILTERED,
        userid: FILTERED,
        user_id: FILTERED,
        UserId: FILTERED,
        bar: '123',
      });
    });

    it('filters token values', () => {
      const token1 = uuid.v4().replace(/-/g, '');
      const token2 = uuid.v4().replace(/-/g, '');
      const token3 = uuid.v4().toString();
      const result = CommonPiiActions.tokenValues.execute({
        foo: `-- ${token1}\n${token2}--`,
        bar: token3,
      });

      expect(result).to.deep.equal({
        foo: `-- ${FILTERED}\n${FILTERED}--`,
        bar: token3,
      });
    });

    it('filters token value in url', () => {
      const result = CommonPiiActions.tokenValues.execute(
        'https://foo.bar/?uid=12345678123456781234567812345678'
      );
      expect(result).to.equal(`https://foo.bar/?uid=${FILTERED}`);
    });

    it('filters multiple multiline token values', () => {
      const token = '12345678123456781234567812345678';
      const result = CommonPiiActions.tokenValues.execute(
        `${token}--${token}\n${token}`
      );
      expect(result).to.equal(`${FILTERED}--${FILTERED}\n${FILTERED}`);
    });
  });
});
