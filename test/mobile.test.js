import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../public/js/mobile.js';

describe('the phone app’s update notice', () => {
    test('only a higher version counts as newer', () => {
        assert.equal(isNewer('4.4.0', '4.3.1'), true);
        assert.equal(isNewer('4.3.2', '4.3.1'), true);
        assert.equal(isNewer('5.0.0', '4.9.9'), true);
        assert.equal(isNewer('4.10.0', '4.9.0'), true);
        assert.equal(isNewer('4.3.1', '4.3.1'), false);
        assert.equal(isNewer('4.3.0', '4.3.1'), false);
        assert.equal(isNewer('3.9.9', '4.0.0'), false);
    });

    test('anything that isn’t a plain version is ignored', () => {
        for (const bad of [undefined, null, '', '4.4', '4.4.0-beta', 'v4.4.0', '4.4.0 ', 440, { version: '9.9.9' }, '9.9.9<script>']) {
            assert.equal(isNewer(bad, '4.3.1'), false);
            assert.equal(isNewer('4.4.0', bad), false);
        }
    });
});
