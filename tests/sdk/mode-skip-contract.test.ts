import { afterAll, describe, expect, it } from 'bun:test';
import { readdirSync } from 'fs';
import { join } from 'path';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

// plan-18 step 2 (#3624): a skip is the <skip_summary /> sentinel, never
// silence. The worker asks again for a queued batch whose reply is neither XML
// nor the sentinel, so a mode that still told the observer to skip with an
// empty reply would pay for every skip twice. Locales and the --chill variants
// resolve through ModeManager's inheritance, so every mode file is checked as
// the observer actually receives it.
const MODES_DIR = join(import.meta.dir, '..', '..', 'plugin', 'modes');
const modeIds = readdirSync(MODES_DIR)
  .filter(file => file.endsWith('.json'))
  .map(file => file.slice(0, -'.json'.length))
  .sort();

describe('every mode states the skip contract (#3624)', () => {
  afterAll(() => {
    ModeManager.getInstance().loadMode('code');
  });

  it('covers every mode file', () => {
    expect(modeIds.length).toBeGreaterThan(30);
  });

  it('code and its locale descendants preserve useful failed research and skip actual noise', () => {
    // Chill has its own selective recording/skip policy, outside this contract.
    const codeModes = modeIds.filter(id => id === 'code' || (id.startsWith('code--') && id !== 'code--chill'));
    expect(codeModes).toContain('code--fr');
    for (const modeId of codeModes) {
      const { recording_focus, skip_guidance, field_guidance } = ModeManager.getInstance().loadMode(modeId).prompts;
      expect(recording_focus).toContain('Concrete debugging or investigative findings');
      expect(skip_guidance).toContain('File research with no new durable finding');
      expect(skip_guidance).toContain('failed diagnostic command is not automatically noise');
      expect(skip_guidance).toContain('only when new and useful');
      expect(skip_guidance).toContain('skip all later re-confirmations of the identical fact');
      expect(skip_guidance).toContain('Simple file listings with no follow-on finding');
      expect(skip_guidance).toContain('<skip_summary reason="noise" />');
      expect(skip_guidance).not.toContain('File related research that comes back empty or not found');
      expect(field_guidance).toContain('paths and read/modified roles supported by the supplied tool evidence');
    }
  });

  for (const modeId of modeIds) {
    it(`${modeId} asks for <skip_summary />, never an empty reply`, () => {
      const guidance = ModeManager.getInstance().loadMode(modeId).prompts.skip_guidance;
      expect(guidance).toContain('<skip_summary reason="noise" />');
      expect(guidance).not.toContain('empty response only');
      expect(guidance).not.toContain('No output necessary');
    });
  }
});
