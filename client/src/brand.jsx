/** Brand mark and the small line-icon set. */
const ICONS = {
  sun: 'M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z',
  calendar: 'M5 6h14v13H5zM5 10h14M9 4v4M15 4v4',
  check: 'M5 12.5l4 4 10-10',
  inbox: 'M4 13l2.5-7h11L20 13v5H4zM4 13h5l1 2h4l1-2h5',
  chat: 'M5 6h14v9H10l-4 3v-3H5z',
  people: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.5 19c.7-3 2.8-4.5 5.5-4.5s4.8 1.5 5.5 4.5M16 11a2.5 2.5 0 1 0 0-5M17 14.5c2 .3 3.2 1.7 3.6 4.5',
  sync: 'M19 8a7 7 0 0 0-12.5-2M5 4v3.5h3.5M5 16a7 7 0 0 0 12.5 2M19 20v-3.5h-3.5',
  pin: 'M12 21s-6-5.6-6-10.5a6 6 0 1 1 12 0C18 15.4 12 21 12 21ZM12 8.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  menu: 'M4 7h16M4 12h16M4 17h16',
};

export const Icon = ({ name, size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={ICONS[name]} />
  </svg>
);

export function Logo({ light }) {
  return (
    <span className={`logo${light ? ' light' : ''}`}>
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="10" fill="none" stroke="#F2B33D" strokeWidth="2.6" />
        <circle cx="16" cy="16" r="3.4" fill="currentColor" />
        <circle cx="25.2" cy="10.2" r="2.8" fill="#F2B33D" />
      </svg>
      Orbit
    </span>
  );
}

