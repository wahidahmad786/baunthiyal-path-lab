export const BRAND = {
  name: 'Baunthiyal Path Lab',
  tagline: 'Your Health, Our Priority',
  initials: 'BPL',
  currency: 'INR',
} as const;
export const money = (paise: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: paise % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(paise / 100);
