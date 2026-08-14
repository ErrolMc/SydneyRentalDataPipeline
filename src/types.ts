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
  /**
   * Origin for travel-time enrichment — a street address, place name, or a
   * bare "lat,lng". When set, every listing gets a real routed `travel` time.
   */
  travelFrom?: string;
  travelMode?: "walk" | "drive";
  /** Drop listings whose routed time exceeds this. Unknowns are kept, not dropped. */
  maxTravelMinutes?: number;
  sortByTravel?: boolean;
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
  /** Building position as published by REA. Absent on the odd listing. */
  coords?: { lat: number; lng: number };
  /**
   * Real routed travel time from the `travelFrom` origin. `null` means we could
   * not route it — never a straight-line guess standing in for a real one.
   * `precision:"area"` means the address only resolved to a suburb centroid, so
   * the time is indicative rather than measured.
   */
  travel?: {
    minutes: number;
    km: number;
    mode: "walk" | "drive";
    precision: "building" | "street" | "area";
  } | null;
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
  /** Present only when `travelFrom` was supplied. Describes how times were derived. */
  travelReport?: unknown;
}

export interface LocationSuggestion {
  id: string;
  text: string;
  type: string;
  name?: string;
  state?: string;
  postcode?: string;
}
