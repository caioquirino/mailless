import { formatAddress, formatAddresses, parseAddresses } from './addresses';

describe('parseAddresses', () => {
  it('reads addresses as people type them', () => {
    expect(
      parseAddresses(
        'bob@example.com, Ann Lee <ann@example.com>; "Lee, Carol" <carol@example.com>',
      ),
    ).toEqual({
      addresses: [
        { name: null, email: 'bob@example.com' },
        { name: 'Ann Lee', email: 'ann@example.com' },
        { name: 'Lee, Carol', email: 'carol@example.com' },
      ],
    });
    expect(parseAddresses('  ')).toEqual({ addresses: [] });
    expect(parseAddresses('bob@example.com,')).toEqual({
      addresses: [{ name: null, email: 'bob@example.com' }],
    });
  });

  it('says which piece is not an address', () => {
    expect(parseAddresses('bob@example.com, carol')).toEqual({
      invalid: 'carol',
    });
    expect(parseAddresses('Bob <bob at example.com>')).toEqual({
      invalid: 'Bob <bob at example.com>',
    });
  });

  it('reads back what it writes', () => {
    const addresses = [
      { name: 'Lee, "Carol"', email: 'carol@example.com' },
      { name: null, email: 'bob@example.com' },
    ];
    expect(formatAddress(addresses[0] as (typeof addresses)[0])).toBe(
      '"Lee, \\"Carol\\"" <carol@example.com>',
    );
    expect(parseAddresses(formatAddresses(addresses))).toEqual({ addresses });
  });
});
