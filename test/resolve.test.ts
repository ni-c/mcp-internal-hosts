import { afterEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

const { firstInternalAddress, internalHostsAmong } =
  await import('../src/index.js');

/** What `dns.lookup(name, {all: true})` resolves with. */
const answers = (...addresses: string[]) =>
  addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }));

afterEach(() => {
  lookup.mockReset();
});

describe('resolving a name', () => {
  it('decides a literal without asking the resolver at all', async () => {
    // A literal is already the answer. Asking would be a lookup per call for
    // nothing, and would make the fail-open half apply where it need not.
    expect(await firstInternalAddress('127.0.0.1')).toEqual({
      address: '127.0.0.1',
      kind: 'loopback',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('catches a name that points at the machine itself', async () => {
    // The case a literal check alone walks straight past: nothing stops an
    // attacker-controlled domain from publishing a 127.0.0.1 record.
    lookup.mockResolvedValue(answers('127.0.0.1'));
    expect(await firstInternalAddress('sneaky.example.com')).toEqual({
      address: '127.0.0.1',
      kind: 'loopback',
    });
  });

  it('catches the metadata address behind a name', async () => {
    lookup.mockResolvedValue(answers('169.254.169.254'));
    expect(await firstInternalAddress('totally.fine.example')).toEqual({
      address: '169.254.169.254',
      kind: 'link-local',
    });
  });

  it('reports the first internal address among several', async () => {
    lookup.mockResolvedValue(answers('93.184.216.34', '::1'));
    expect(await firstInternalAddress('mixed.example')).toEqual({
      address: '::1',
      kind: 'loopback',
    });
  });

  it('leaves a routable name alone', async () => {
    lookup.mockResolvedValue(answers('93.184.216.34'));
    expect(await firstInternalAddress('example.com')).toBeNull();
  });

  it('does not treat a sinkholed name as loopback', async () => {
    // Every ad blocker and every corporate DNS filter answers 0.0.0.0 or ::.
    // That is the resolver declining to answer, not the name addressing this
    // machine — calling it loopback would misdescribe it and make every
    // blocklisted domain unusable. Nothing is reachable from it either way.
    for (const sink of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0']) {
      lookup.mockResolvedValue(answers(sink));
      expect(await firstInternalAddress('blocked.example'), sink).toBeNull();
    }
  });

  it('still finds an internal address listed after a sinkhole answer', async () => {
    lookup.mockResolvedValue(answers('0.0.0.0', '169.254.169.254'));
    expect(await firstInternalAddress('mixed.example')).toEqual({
      address: '169.254.169.254',
      kind: 'link-local',
    });
  });

  it('is fail-open when the resolver refuses', async () => {
    // Documented, not accidental: the fetching server may sit in a different
    // network with its own resolver, so a name that does not resolve here is a
    // real setup rather than a signal.
    lookup.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await firstInternalAddress('nowhere.example')).toBeNull();
  });

  it('is fail-open when the resolver answers nothing', async () => {
    lookup.mockResolvedValue([]);
    expect(await firstInternalAddress('empty.example')).toBeNull();
  });

  it('gives up on a resolver that answers slowly', async () => {
    // The switch the other side holds: whoever is authoritative for a name can
    // simply answer slowly. Waiting is not an option, so the timeout wins and
    // the caller is told this is a barrier, not a boundary.
    lookup.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(answers('127.0.0.1')), 5000)
        )
    );
    const started = Date.now();
    expect(
      await firstInternalAddress('slow.example', { timeoutMs: 20 })
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not resolve an address that is simply routable', async () => {
    expect(await firstInternalAddress('1.1.1.1')).toBeNull();
    expect(await firstInternalAddress('')).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('resolving a list', () => {
  it('reports only the hosts that came out internal', async () => {
    lookup.mockResolvedValue(answers('93.184.216.34'));
    const found = await internalHostsAmong([
      'example.com',
      '127.0.0.1',
      'localhost',
    ]);
    expect([...found.keys()].sort()).toEqual(['127.0.0.1', 'localhost']);
    expect(found.get('localhost')?.kind).toBe('loopback');
  });

  it('is empty when the whole list is fine', async () => {
    lookup.mockResolvedValue(answers('93.184.216.34'));
    expect((await internalHostsAmong(['a.example', 'b.example'])).size).toBe(0);
  });

  it('decides the literals even when the budget is already spent', async () => {
    // Literals cost nothing, so they must never be the entries a slow resolver
    // squeezes out — otherwise a list long enough to exhaust the budget would
    // let an obvious 169.254.169.254 through.
    lookup.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(answers('93.184.216.34')), 5000)
        )
    );
    const names = Array.from({ length: 50 }, (_, i) => `n${i}.example`);
    const found = await internalHostsAmong([...names, '169.254.169.254'], {
      budgetMs: 0,
      timeoutMs: 20,
    });
    expect(found.get('169.254.169.254')?.kind).toBe('link-local');
  });

  it('stops resolving once the total budget is spent', async () => {
    // A list may name thousands of hosts. Against a resolver that black-holes
    // queries the lookups alone would outlast any sane call.
    lookup.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(answers('93.184.216.34')), 60)
        )
    );
    const names = Array.from({ length: 200 }, (_, i) => `n${i}.example`);
    const started = Date.now();
    await internalHostsAmong(names, {
      budgetMs: 100,
      concurrency: 4,
      timeoutMs: 500,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lookup.mock.calls.length).toBeLessThan(names.length);
  });

  it('resolves in batches rather than one lookup at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    lookup.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return answers('93.184.216.34');
    });
    await internalHostsAmong(
      Array.from({ length: 12 }, (_, i) => `n${i}.example`),
      { concurrency: 4 }
    );
    expect(peak).toBe(4);
  });

  it('passes literals and empty entries by without a lookup', async () => {
    // A list is whatever the caller collected — an OPML file, a config block —
    // so it holds addresses and blanks alongside names.
    lookup.mockResolvedValue(answers('93.184.216.34'));
    const found = await internalHostsAmong([
      '',
      '1.1.1.1',
      '::1',
      'example.com',
    ]);
    expect([...found.keys()]).toEqual(['::1']);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('never runs fewer than one lookup at a time', async () => {
    // A caller passing 0 means "as few as possible", not "none at all".
    lookup.mockResolvedValue(answers('127.0.0.1'));
    const found = await internalHostsAmong(['a.example'], { concurrency: 0 });
    expect(found.get('a.example')?.kind).toBe('loopback');
  });

  describe('stopAtFirst', () => {
    it('starts no further batch once something was found', async () => {
      // The caller this exists for throws on the first hit, so every lookup
      // after it is work whose answer is discarded — and against a slow
      // resolver it is the whole budget.
      lookup.mockResolvedValue(answers('127.0.0.1'));
      const names = Array.from({ length: 40 }, (_, i) => `n${i}.example`);
      const found = await internalHostsAmong(names, {
        stopAtFirst: true,
        concurrency: 4,
      });
      expect(found.size).toBeGreaterThan(0);
      // The batch in flight finishes — that is the point of keeping
      // concurrency — but no later one starts.
      expect(lookup).toHaveBeenCalledTimes(4);
    });

    it('spends no lookup at all when a literal already answers it', async () => {
      // Literals are decided before any DNS, so a list whose first entry is an
      // address is answered without touching the resolver.
      lookup.mockResolvedValue(answers('93.184.216.34'));
      const found = await internalHostsAmong(
        ['127.0.0.1', ...Array.from({ length: 40 }, (_, i) => `n${i}.example`)],
        { stopAtFirst: true }
      );
      expect([...found.keys()]).toEqual(['127.0.0.1']);
      expect(lookup).not.toHaveBeenCalled();
    });

    it('is off by default, so the full map is still the normal answer', async () => {
      // The negative control: the same input without the option must resolve
      // everything, or the option would be describing the default.
      lookup.mockResolvedValue(answers('127.0.0.1'));
      const names = Array.from({ length: 12 }, (_, i) => `n${i}.example`);
      const found = await internalHostsAmong(names, { concurrency: 4 });
      expect(found.size).toBe(names.length);
      expect(lookup).toHaveBeenCalledTimes(names.length);
    });

    it('returns an empty map when nothing is internal, having looked at all of them', async () => {
      // Stopping early must not turn "none found" into "stopped looking".
      lookup.mockResolvedValue(answers('93.184.216.34'));
      const names = Array.from({ length: 8 }, (_, i) => `n${i}.example`);
      const found = await internalHostsAmong(names, {
        stopAtFirst: true,
        concurrency: 4,
      });
      expect(found.size).toBe(0);
      expect(lookup).toHaveBeenCalledTimes(names.length);
    });
  });
});
