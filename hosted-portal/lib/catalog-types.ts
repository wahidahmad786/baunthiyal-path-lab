export type CatalogEntry = {
  id: string;
  name: string;
  type: 'test' | 'package';
  price: number | null;
  category?: string;
  aliases?: string[];
};
