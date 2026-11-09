# Location cleanup: before and after

Step 2 of map search. This step fixes how the board reads locations, at the source. Nothing on the map is built yet. Everything here is local, on branch `location-cleanup`: nothing is pushed, deployed or written to the box, and no production backfill has run.

The baseline is `geonames-coverage.md`, in this folder.

## How it was measured

I pulled the raw `location` strings from the live database read-only, over SSM, in 48 slices. The pull took every one of the 20,000 most common strings, which cover 67.6% of open jobs, plus a 7% random sample of the other 213,041, weighted back up. That is 34,891 strings. Weighted, they stand for 1,330,950 open jobs, against 1,330,841 on the box, so the sample is a fair stand-in for the whole set. The stored `country` and `city` columns equal what the old parser produces for every one of those jobs except 275, so re-parsing locally reproduces the board.

Each string was read three ways: the stored columns, the old parser, and the new parser. The old matcher ran on the stored values. The new matcher ran on the new parser's places. All numbers below are from that sample.

## Coverage, before and after

Placements by method. "Before" is the stored values with the old matcher. "After" is the new parser and matcher.

| Method | Before | After | Change |
|---|---:|---:|---:|
| exact | 567,090 | 577,506 | +10,416, not counted, see accuracy |
| state | | 220,567 | new |
| alias (old, untagged and tagged) | 35,806 | | removed |
| alias-en | | 31,236 | |
| alias-he | | 313 | |
| manual | | 17,164 | |
| **Placed** | **602,896 (49.5%)** | **846,786 (73.1%)** | **+243,890** |
| region | 26,667 | 5,612 | |
| ambiguous, not placed | 357,564 | 102,346 | -255,218 |
| unmatched, not placed | 230,323 | 204,389 | |
| Total placements | 1,217,450 | 1,159,133 | |

The totals differ for two reasons:

- **Countries no longer cross.** The new parser keeps each city with its own country, so "Tel Aviv, Israel; New York, NY" no longer files Tel Aviv under the US. The board's own filter still does, because that code is untouched.
- **Provinces are no longer cities.** That is most of the drop in the region class.

Counted by jobs, which matters more for a map:

| | Before | After |
|---|---:|---:|
| Open jobs with at least one placed city | 558,575 (42.0%) | 773,699 (58.1%) |
| The same, without the exact gain | | 752,557 (56.5%) |
| Jobs whose only places are ambiguous | 289,661 (21.8%) | 91,680 (6.9%) |
| US jobs placed | 36.9% | 67.6% |
| Israeli jobs placed | 57.7% | 57.7% |
| Jobs with no country | 294,115 | 239,551 |
| Jobs with no city | 169,852 | 191,988 |

The number of jobs with no city goes up on purpose. Provinces, street addresses, postal codes and coordinates used to be stored as cities, and they no longer are.

## Accuracy after the change

I hand-checked a sample the same way as the baseline. Each place came with the raw location strings behind it, and I judged whether the point is the place the posting means. The sample is stratified by method and uniform within each method. The full table with raw strings and verdicts is in `match-sample-after.tsv`.

| Method | Checked | Wrong | Error rate (95% interval) | Baseline |
|---|---:|---:|---|---|
| exact | 70 | 2 | 2.9% (0.8 to 9.8%) | 2.1% (0.6 to 7.4%), 94 checked |
| state | 30 | 0 | 0% (0 to 11.4%) | new method |
| alias-he | 13 | 0 | 0% (0 to 22.8%) | tagged aliases 0 of 18 |
| alias-en | 39 | 2 | 5.1% (1.4 to 16.9%) | untagged aliases 30%, all aliases 18.8%, tagged 0 of 18 |
| region | 20 | 1 | 5.0% (0.9 to 23.6%) | not sampled |
| manual | 4 entries | 0 | each geonameid checked by hand | |
| All checked | 176 | 5 | 2.8% | uniform 4.0% (1.6 to 9.8%) |

**Exact went up, from 2.1% to 2.9%.** The intervals overlap almost completely, and the exact rule itself did not change. Both errors would have happened before too:

- "Sales, Paris, Hybride": Sales is the department, and it matched a French village.
- "Kingsbury, Greater London": it matched the Warwickshire village.

The owner's rule still applies, so I don't count exact's gain. The 10,416 extra exact placements are left out of the headline above. The 58.1% job figure becomes 56.5% without them.

**Alias-en needs a caveat.** It is far below the old alias method's 18.8% and the untagged list's 30%. It is above the 0 of 18 that tagged aliases scored at baseline, though that sample was small. The first 20 alias-en checks found 3 errors, so I added a rule and checked 20 more:

- **The rule:** a name that is a first-level region in its country is the region, not some town's alternate name. The exception is a town inside that region, such as Bucharest.
- **Fixed:** Perak, the Malaysian state, which had matched Kampung Perak in another state.
- **Still wrong:** "Long Island, NY", matched to Long Island City in Queens, and "Midtjylland", the Danish region, matched to Karup.

**The region error** is "Tas-Sliema", which is the town of Sliema but is filed as a region and so is not placed.

### What dropping the untagged aliases cost

Of the 35,806 old alias placements:

- **24,026** are still placed.
- **3,994** moved under their English name, for example Wien to Vienna.
- **1,306** are now regions, mostly Malaysian states.
- **6,480** are no longer placed.

The 6,480 mix wrong old matches with right ones. "Headquarters" as Portola is wrong. Taoyuan City, Al Khobar and Kempten were right. At the baseline's 30% error rate for that list, about 4,500 correct placements are given up. Bangalore (14,319) and Gurgaon (2,393) would have been lost too, so they went into the manual table. A few city names in their own language went into the parser's alias table, which also merges them in the board's filter: Wien, Milano, Lisboa, Den Haag, Antwerpen, Bruxelles, Bucuresti, Torino, Roma, Nürnberg, Genève, Napoli, Firenze, Ho Chi Minh.

## What changes in the board's filter

These come from the parser and change the live board once deployed. In the sample:

- The city string changes for 166,409 jobs (12.5%) and the country string for 55,445 (4.2%).
- The city filter offers "CC:City" values. 1,876 values disappear, worth 77,600 job placements, and 1,436 appear, worth 33,857. The total goes from 15,502 to 15,062 values in the sample.
- Values that disappear are regions and junk that were offered as cities: IN:Karnataka 3,215, NL:Nederland 2,441, CA:Quebec 2,148, CA:British Columbia 1,414, IN:Telangana 1,358, CA:Alberta 1,148, DE:Nordrhein-Westfalen 911, AU:Victoria 677, US:D.C. 526, GB:NY 12208 495, US:15212 326.
- Values that appear mostly belong to jobs whose country is now known, so the city reaches the filter for the first time: US:Jefferson Hills 306, CA:Candiac 114, CA:Haliburton 114, NL:Blerick 100, CA:Prince Albert 86. Some are site names that were already stored as cities with no country, and now show: "US:Store0333 Alpharetta", "CA:Sunrise of Thornhill", "US:Hartwell Health & Rehab". They were junk before, and the country recovery only makes them visible.
- Country examples: "Utrecht, Utrecht, Nederland" had none and now has NL. "Edmonton, Alberta" now has CA. "Erie PA, 16502, 232 West 25th St" now has US. "CA, Ontario, Brockville" moves from US to CA.

A known imperfection: "London, Ontario" now gets both GB and CA, because London is in the city list as British. Before, it got GB alone, which was wrong too.

Deploying this changes the board gradually, with no backfill. The loader re-derives the country and city whenever a job is polled again, and `would_not_change` treats a different value as a change. The stored values therefore converge as boards are re-read: about 166,000 rows get written once over the following days. `PLACES_VERSION` in the loader is deliberately not bumped. Bumping it would re-tag every row in one sweep series, which is a backfill, and that is the owner's call.

## What changed, and its tests

**api/countries.py, the parser that fills `jobs.country` and `jobs.city` in the scraper and the loader:**

- **:80** Country names in their own language: Nederland, España, Italia, Polska, Schweiz, Österreich and others.
- **:193, :653** Yokneam Illit and the Hebrew Yokneam are Yokneam, in Israel.
- **:286** `US_STATE_CODES`, so a city keeps its state.
- **:313** `ADMIN1`, the provinces, states and Länder of 16 countries. A region names its country and is never a city.
- **:365** `ADMIN1_IN_COUNTRY`, region names that are also cities elsewhere, such as Victoria. They count as a region only when the same group names their country.
- **:374** `PROVINCE_CODES`, Canadian and Australian codes.
- **:421** A state stuck to a city or a ZIP code: "Erie PA", "Newton-MA", "NY 12208".
- **:425** `_us_state_code`, which also reads "D.C.".
- **:431** `_admin1_country`. "Ontario, CA" written first is Ontario, California.
- **:541-567** A province code beats a US state code in the same group. "Brockville, ON, CA" is Canada, and its CA is too.
- **:629** Own-language city names map to the English name the board lists.
- **:663** "Telecommuter" is not a place.
- **:689** A postal code, street address, coordinate or PO box is not a city.
- **:701** `_tokens`, which says what each segment is. `cities_of` (:765) now reads it.
- **:780** `places_of`, which returns (country, US state, city) for each city, with the country and state written beside it. It never guesses a state, and a city with no state stays without one.

**loader/location_places.py (new):**

- **:103** `classify`. Aliases come only from tagged Hebrew and English names. The US state resolves a name only when exactly one candidate is left; two in the same state stay unresolved, and a single candidate in another state is unresolved as "state-mismatch". A region name beats a town's alias (:126).
- **:86** `MANUAL`: Yokneam Illit, Yehud, Bangalore, Gurgaon.
- The storage, described below.

**scripts/geonames_coverage.py** now takes its rules from the loader module, so both use one copy. `--gazetteer-out` writes the compact gazetteer file the box reads.

**Wiring:**

- **loader/load_to_sqlite.py:2438** adds `--gazetteer`.
- **loader/load_to_sqlite.py:2583-2594** calls the box sweep.
- **box/shadow_apply.py:396-400** passes `--gazetteer` only when `gazetteer.tsv.gz` sits beside `jobs.db`.

**Tests:**

- **tests/test_countries.py** gains about 60 cases. Every string is from the live board or the earlier report: the Brockville and Quebec cases, Bengaluru with Karnataka, Seattle with Washington, Erie PA, Yokneam, own-language names, and `places_of`, including multi-country and multi-state strings. Two new invariants: no region is also a listed city or country, and every region names a known country. The existing Israel trap tests still pass.
- **tests/test_geonames_coverage.py** covers each method, state resolution that never picks between two candidates, state mismatch, region against alias, and manual.
- **tests/test_location_places.py** covers the stored methods and original strings, idempotent and capped runs, closed jobs, selective re-runs, that `jobs` is untouched, and the no-gazetteer case.
- `test_israel_false_friends`, `test_city_in_country`, `test_place_search`, `test_bootstrap_country`, `test_unchanged_skip`, `test_unchanged_state` and `test_shadow_apply_stream` all pass unchanged.

## Keeping the method in production data

The proposal is one side table, keyed by the location string itself:

```sql
CREATE TABLE IF NOT EXISTS location_places (
    location      TEXT NOT NULL,     -- the raw jobs.location string, exactly as stored
    ord           INTEGER NOT NULL,  -- 0, 1, ... in the order the string names its cities
    country       TEXT,
    state         TEXT,              -- US state code when written beside the city
    city          TEXT,              -- the board's city name
    geonameid     INTEGER,           -- NULL unless placed
    method        TEXT NOT NULL,     -- exact, state, alias-he, alias-en, manual, region, unresolved
    detail        TEXT,              -- why unresolved (ambiguous, unmatched, state-mismatch, no country,
                                     -- no city, no gazetteer), or the region's name
    rules_version TEXT NOT NULL,     -- e.g. "1/geonames-2026-11-09": code rules / gazetteer build
    assigned_at   TEXT NOT NULL,
    PRIMARY KEY (location, ord)
) WITHOUT ROWID;
```

**Why it is keyed by the string and not by job.** A place depends only on the string and the rules. The 1.3 million open jobs share 233,041 strings, so the table stays small, and the job is reached through `jobs.location`. Keying by string also keeps the original location, as the owner asked, without copying it onto every job.

**The migration** is a `CREATE TABLE IF NOT EXISTS` on a new table. `jobs` is never altered or rewritten, and no index is added to it. Measured on the sample, the table takes 206 bytes per location string, about 48 MB for the full set. On a disk-bound box that is the cost to weigh.

**How the loader fills it:**

1. Each box sweep (`_box_sweep_due`) places up to 20,000 strings, so about 12 sweeps place the whole set.
2. A sweep starts with strings whose rows came from another rules version, then strings no row has seen yet.
3. The search for unseen strings reads every open job once it has nothing left to find. That is similar to the 16-second full scan measured on the box. It is never fatal: on error the sweep logs and moves on.
4. Locally a 20,000-string batch took about 10 seconds, most of it reading the gazetteer.
5. The gazetteer is read only for the names that batch needs, so memory stays small.

**Nothing happens until the owner puts the gazetteer on the box.** The code ships inert:

1. Build the file with `scripts/geonames_coverage.py ... --gazetteer-out gazetteer.tsv.gz --gazetteer-version geonames-YYYY-MM-DD`. It is 5.5 MB, and GeoNames data needs the "GeoNames, geonames.org" credit.
2. Copy it beside `jobs.db`. The applier then passes `--gazetteer`, and the next sweep creates the table and starts.

The scrape Lambdas carry `load_to_sqlite.py` but never pass `--gazetteer`. The new module is imported only inside that branch, so their packages need no change.

**Re-running selectively:** bump `RULES_VERSION` in `loader/location_places.py` when a rule changes, or ship a newer gazetteer, and the rows from the old version are redone, a batch per sweep. To look at what a rule decided, query the table directly:

```sql
SELECT method, detail, COUNT(*) FROM location_places GROUP BY 1, 2;
SELECT * FROM location_places WHERE method = 'alias-en' AND rules_version = '1/geonames-2026-11-09';
DELETE FROM location_places WHERE method = 'unresolved' AND detail = 'ambiguous';  -- redone next sweep
```

I verified it on the sample. The box backfill, run over all 34,891 strings with the real gazetteer, gave the same method for every one of the 16,879 distinct places as the report script.

## For the map, later

A city's count on the map must not mix placements made with confidence and placements that could not be made. When the index is built, each point should carry:

- the jobs placed there by exact, state, alias or manual matches;
- the jobs that might belong there but were not placed, such as "Austin" with no state, which could be any of four Austins.

The second number shows as a note, never inside the dot's count. "Austin, Texas: 5,837 jobs, plus 2,976 that name Austin without a state" is honest. 8,813 on the dot would not be.

## Not verified

- **Box performance.** The scan time for unseen strings, the sweep's memory, and the write burst from re-polled jobs after the parser deploys were measured locally or estimated, not on the box.
- **Lambda packages.** I checked by reading that the scrape Lambdas never import the new module. I did not build a package.
- **The alias-he sample** is 13 places, every Hebrew alias in the sample. Hebrew is rare outside Israel.
- **Regions outside the 16 countries in `ADMIN1`** still land as cities: Oberösterreich (AT), Japanese prefectures, Turkish provinces. The matcher still files them as regions, so they stay off the map.
- **Frankfurt (DE)** stays ambiguous between Frankfurt am Main and Frankfurt (Oder). It is a candidate for the manual table, but that choice belongs to the owner, because it picks between two candidates.
