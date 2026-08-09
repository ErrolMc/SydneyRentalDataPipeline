/** Search channel — maps to REA's URL prefix and GraphQL root field. */
export type Channel = "buy" | "rent" | "sold";

export interface SearchParams {
  /** Free-text location, e.g. "bondi, nsw 2026". Resolved via the suggest API when ambiguous. */
  location: string;
  channel: Channel;
  page?: number;
  minPrice?: number;
  maxPrice?: number;
  minBedrooms?: number;
  maxBedrooms?: number;
  minBathrooms?: number;
  minCarSpaces?: number;
  minLandSize?: number;
  /** apartment | house | townhouse | villa | land | acreage | unitblock | retirement */
  propertyTypes?: string[];
  surroundingSuburbs?: boolean;
  excludeUnderContract?: boolean;
  /** Rent only. */
  furnished?: boolean;
  petsAllowed?: boolean;
  /** Sold only — how far back to look. */
  soldWithinMonths?: number;
}

export interface Agent {
  name: string;
  jobTitle?: string;
  profileUrl?: string;
}

export interface Agency {
  name?: string;
  id?: string;
  avgRating?: number;
  totalReviews?: number;
}

export interface Listing {
  id: string;
  url?: string;
  address: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  price: string;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  carSpaces?: number;
  studies?: number;
  landSize?: string;
  buildingSize?: string;
  agency?: Agency;
  agents?: Agent[];
  /** ISO 8601 with offset, e.g. 2026-08-13T09:00:00+10:00 */
  inspections?: { start: string; end?: string; label?: string }[];
  auction?: { dateTime?: string; label?: string };
  description?: string;
  images?: string[];
  floorplans?: string[];
  /** Sold channel only. */
  soldPrice?: string;
  soldDate?: string;
  /**
   * True when REA returned this from a neighbouring suburb rather than the one
   * searched. REA blends these into every result page by default.
   */
  isSurrounding?: boolean;
}

/** Detail pages carry everything a search result does, plus these. */
export interface ListingDetail extends Listing {
  /** Comparable recent sales nearby, as surfaced by REA. */
  recentSales?: unknown;
  /** Suburb-level median/trend data, as surfaced by REA. */
  marketInsights?: unknown;
  relatedListingIds?: string[];
}

export interface SearchResult {
  channel: Channel;
  location: string;
  page: number;
  totalResults?: number;
  totalPages?: number;
  listings: Listing[];
  sourceUrl: string;
}

export interface LocationSuggestion {
  id: string;
  text: string;
  type: string;
  name?: string;
  state?: string;
  postcode?: string;
}
