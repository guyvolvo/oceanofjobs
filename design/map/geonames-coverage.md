# GeoNames coverage and match accuracy

Map-based search, step 1. This report checks how well the board's stored city strings match GeoNames, how accurate the automatic matches are, and how large the location index would be. Nothing for the map itself has been built yet. That waits for review of this report.

Snapshot: production `jobs.db`, open jobs only (`closed_at IS NULL`), read on 2026-11-09 between 14:40 and 15:20 Israel time. Every query opened the file with `?mode=ro` and `PRAGMA query_only=1`, ran over SSM, and printed its result. Nothing was written on the box.

GeoNames files: `cities1000.zip`, `admin1CodesASCII.txt` and `alternateNamesV2.zip` dated 2026-11-09. From `alternateNamesV2` I kept only Hebrew and English rows for cities in `cities1000` and for admin1 regions, 57,063 rows out of 19.25 million. GeoNames data is CC BY 4.0 and needs the credit "GeoNames, geonames.org" wherever the map shows it.

Files next to this report:

- `ambiguous.tsv`, every ambiguous pair with up to 10 candidates each: geonameid, name, admin1, population, coordinates.
- `match-sample.tsv`, the 190 hand-checked matches, with the raw location strings behind each one and my verdict.
- `../../scripts/geonames_coverage.py`, the matcher.

## How the pairs were counted

`country` and `city` are comma-joined columns. The board's facets already split them the same way, in `api/aggregates.py`: every city in a row is paired with every country in that row. I did the same, so the numbers match what the board's location filter offers. A job naming two cities counts once at each, so the counts below are placements, not jobs.

| | Count |
|---|---:|
| Open jobs | 1,330,742 |
| Open jobs with no country | 293,654 |
| Open jobs with no city | 171,487 |
| Distinct (country, city) pairs | 83,010 |
| Open-job placements across all pairs | 1,216,441 |
| Placements from jobs naming more than one country | 59,056 |

The 293,654 jobs with no country can never be placed on the map, even when they name a city, because the matcher only searches within a country. That is the largest single loss in this report and it sits upstream, in `countries_of`.

## Classes

Each pair is matched within its own country only.

- **exact**: the string equals the GeoNames name or ASCII name of exactly one city, after case folding, accent stripping and removing apostrophes and hyphens.
- **alias**: no exact hit, and the string equals one city's alternate name. Hebrew comes in here.
- **ambiguous**: two or more cities share the name. None of these is resolved. The candidates are listed.
- **region**: no city hit. The string is an Israeli region from the list in the script, or the name of a first-level region such as a state or province.
- **unmatched**: nothing.

| Class | Pairs | Share of pairs | Open-job placements | Share of placements | From single-country jobs |
|---|---:|---:|---:|---:|---:|
| exact | 19,105 | 23.0% | 563,112 | 46.3% | 546,407 |
| alias | 1,585 | 1.9% | 37,679 | 3.1% | 36,992 |
| ambiguous | 3,579 | 4.3% | 356,630 | 29.3% | 350,515 |
| region | 350 | 0.4% | 26,371 | 2.2% | 25,570 |
| unmatched | 58,391 | 70.3% | 232,649 | 19.1% | 197,901 |
| total | 83,010 | 100% | 1,216,441 | 100% | 1,157,385 |

So 49.4% of placements can go on the map today without a decision. Ambiguity is nearly all American: 341,604 of the 356,630 ambiguous placements are US. The board stores a US city without its state, and "Austin" alone matches four Austins. The section on ambiguity below shows that the raw location string fixes most of this.

### By country

The 25 countries with the most placements. Mappable is exact plus alias.

| Country | Placements | Exact | Alias | Ambiguous | Region | Unmatched | Mappable | Remote jobs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| US | 719,528 | 237,484 | 5,761 | 341,604 | 0 | 134,679 | 33.8% | 34,269 |
| IN | 60,808 | 28,586 | 17,039 | 199 | 7,883 | 7,101 | 75.0% | 1,142 |
| GB | 53,737 | 38,690 | 516 | 1,469 | 0 | 13,062 | 73.0% | 2,597 |
| CA | 48,611 | 30,789 | 367 | 1,770 | 7,972 | 7,713 | 64.1% | 2,309 |
| DE | 46,130 | 31,007 | 2,570 | 2,551 | 2,264 | 7,738 | 72.8% | 1,911 |
| FR | 36,813 | 30,593 | 463 | 802 | 633 | 4,322 | 84.4% | 982 |
| AU | 15,903 | 10,984 | 30 | 1,000 | 1,211 | 2,678 | 69.3% | 498 |
| SG | 15,164 | 11,333 | 41 | 13 | 0 | 3,777 | 75.0% | 405 |
| NL | 14,634 | 9,210 | 335 | 106 | 181 | 4,802 | 65.2% | 478 |
| CN | 13,642 | 8,270 | 115 | 2,669 | 965 | 1,623 | 61.5% | 590 |
| ES | 11,973 | 8,209 | 293 | 28 | 244 | 3,199 | 71.0% | 821 |
| PL | 10,295 | 7,329 | 73 | 55 | 9 | 2,829 | 71.9% | 1,017 |
| MX | 10,214 | 6,497 | 372 | 1,550 | 43 | 1,752 | 67.3% | 1,165 |
| JP | 9,121 | 7,021 | 264 | 473 | 141 | 1,222 | 79.9% | 299 |
| IL | 8,848 | 4,491 | 1,354 | 0 | 2,359 | 644 | 66.1% | 101 |
| BR | 8,111 | 6,292 | 141 | 560 | 90 | 1,028 | 79.3% | 702 |
| IE | 7,341 | 4,941 | 68 | 8 | 260 | 2,064 | 68.2% | 341 |
| MY | 7,257 | 4,278 | 1,149 | 8 | 34 | 1,788 | 74.8% | 108 |
| IT | 6,497 | 3,823 | 838 | 10 | 278 | 1,548 | 71.7% | 249 |
| PH | 6,206 | 3,393 | 691 | 162 | 284 | 1,676 | 65.8% | 608 |
| TW | 5,747 | 4,021 | 253 | 0 | 0 | 1,473 | 74.4% | 86 |
| PT | 4,522 | 3,048 | 394 | 20 | 1 | 1,059 | 76.1% | 417 |
| BE | 4,514 | 2,902 | 503 | 20 | 36 | 1,053 | 75.4% | 169 |
| CH | 4,379 | 2,992 | 229 | 17 | 105 | 1,036 | 73.6% | 116 |
| ID | 3,927 | 2,296 | 62 | 166 | 208 | 1,195 | 60.0% | 245 |

Remote jobs are `workplace_type = 'remote'`, counted per country. There are 57,258 across 109 countries.

## Match accuracy

### Method

I drew three samples from the exact and alias matches with a fixed seed:

- 100 pairs uniformly at random, which mostly lands on small places.
- 50 pairs weighted by open jobs, which lands on the places most readers would click.
- 40 more alias pairs, because the first sample held only 6 aliases and 2 of them were wrong.

For every sampled pair I pulled the three most common raw `location` strings behind it from the box, then judged whether the GeoNames point is the place the posting means. The full table with raw strings and verdicts is in `match-sample.tsv`.

### Results

| Sample | Checked | Wrong | Error rate | 95% interval |
|---|---:|---:|---:|---:|
| Uniform, all automatic matches | 100 | 4 | 4.0% | 1.6 to 9.8% |
| Uniform, exact only | 94 | 2 | 2.1% | 0.6 to 7.4% |
| Job-weighted | 50 | 0 | 0% | 0 to 7.1% |
| Uniform and job-weighted together | 150 | 4 | 2.7% | 1.0 to 6.7% |
| All aliases checked | 48 | 9 | 18.8% | 10.2 to 31.9% |
| Aliases from Hebrew or English names in alternateNamesV2 | 18 | 0 | 0% | 0 to 17.6% |
| Aliases only in cities1000's untagged alternate-name list | 30 | 9 | 30.0% | 16.7 to 47.9% |

Two more were close but not exact, and I counted both as correct: Vandenberg, which points about 5 km from the base, and Bengkalis, which points about 100 km from Duri inside the same regency. One alias, Ambérieux, could be either of two French towns. I left it uncertain.

Exact matches are good. The job-weighted sample had no errors, so the big cities that carry most placements are right. Aliases are the weak class, and the source of the alias decides it. Every alias error came from the alternate-name column in `cities1000.txt`, which has no language tag and no historic flag. That is how "Parrish" became Kosciusko, Mississippi and "Brockville" became Fremont, Indiana, both from old names. The 427 tagged-alias pairs hold 8,219 placements and the 1,158 untagged ones hold 29,460.

### What the errors were

- **A region written where a city goes.** "Quebec" (2,024 placements) is almost always "Montreal, Quebec", the province, and it matched Quebec City. The same thing happened with "Santa Cruz" in Argentina, "Kocaeli" in Turkey and "Ba Ria" from "Ba Ria - Vung Tau". This is the one error with weight behind it.
- **An office or site name taken as a city.** "Wilson - Pine" became Pine, Arizona. "Wauwatosa - Discovery" became Ester, Alaska.
- **A wrong country upstream.** "CA, Ontario, Brockville" was filed under the US, so "CA" was read as California. "Torrington, CT" was filed under GB.
- **An untagged alternate name pointing at another town**: Fox Valley, Elk, Parrish, Brockville.

## Ambiguous pairs

3,579 pairs, 356,630 placements. None is resolved here. The full list with candidates is in `ambiguous.tsv`. I added two hints to help decide on rules, and neither has been applied:

| Hint | Pairs | Placements |
|---|---:|---:|
| All candidates within 25 km of each other, so the same place twice | 40 | 391 |
| Largest candidate has at least 10 times the population of the next | 896 | 203,685 |
| Neither | 2,643 | 152,554 |

### The raw location resolves most US cases

For US jobs that name one city and one country, I read the state from the raw `location` string, either a two-letter code or a full state name, and checked how many candidates sit in that state.

| Result | Open jobs | Share |
|---|---:|---:|
| Exactly one candidate in the stated state | 166,312 | 71.7% |
| No state in the location string | 58,183 | 25.1% |
| No candidate in the stated state | 5,456 | 2.4% |
| Several candidates in the stated state | 1,970 | 0.8% |
| Total checked | 231,921 | |

Most of the "no candidate in the stated state" jobs are Washington, D.C. "D.C." is not one of the state forms the check reads, so 3,308 of the 5,456 are Washington jobs. Storing the state next to the city when the location is parsed would make about three quarters of US ambiguity exact, with no guessing. The remaining quarter has no state anywhere in the posting. Those need a rule, such as taking the dominant candidate, or they stay off the map.

### Largest ambiguous pairs, US

| String | Placements | Candidates, admin1 and population | Spread km | Hint |
|---|---:|---|---:|---|
| New York | 30,810 | New York City (New York, 8,804,190); York (Nebraska, 7,864); Clinton (Wisconsin, 2,140) | 1,979 | one dominant |
| Washington | 15,122 | Washington (District of Columbia, 689,545); Washington (Utah, 24,299); Washington (Illinois, 16,664); +13 more | 3,757 | one dominant |
| Austin | 9,157 | Austin (Texas, 974,447); Austin (Minnesota, 24,563); +2 more | 1,548 | one dominant |
| Boston | 7,503 | Boston (Massachusetts, 653,833); Boston (New York, 8,049); Boston (Georgia, 1,323) | 1,712 | one dominant |
| Atlanta | 7,062 | Atlanta (Georgia, 510,823); Atlanta (Texas, 5,605); +2 more | 1,577 | one dominant |
| Houston | 6,765 | Houston (Texas, 2,314,157); Houston (Mississippi, 3,544); +3 more | 5,273 | one dominant |
| Dallas | 6,356 | Dallas (Texas, 1,326,087); Dallas (Oregon, 15,277); +3 more | 3,808 | one dominant |
| Charlotte | 5,320 | Charlotte (North Carolina, 911,311); Charlotte (Michigan, 9,054); +3 more | 2,828 | one dominant |
| Denver | 5,139 | Denver (Colorado, 729,019); Denver (Pennsylvania, 3,875); +2 more | 2,447 | one dominant |
| Santa Clara | 4,122 | Santa Clara (California, 126,215); Santa Clara (Utah, 6,841); Santa Clara (New Mexico, 1,638) | 1,353 | one dominant |
| Nashville | 3,952 | Nashville (Tennessee, 689,447); Nashville (North Carolina, 5,460); +6 more | 1,668 | one dominant |
| San Diego | 3,835 | San Diego (California, 1,404,452); San Diego (Texas, 4,368) | 1,896 | one dominant |
| Philadelphia | 3,764 | Philadelphia (Pennsylvania, 1,573,916); Philadelphia (Mississippi, 7,391); +1 more | 1,717 | one dominant |
| Phoenix | 3,760 | Phoenix (Arizona, 1,650,070); Phoenix (Oregon, 4,553); +2 more | 3,749 | one dominant |
| Miami | 3,588 | Miami (Florida, 487,014); Miami (Oklahoma, 13,611); +2 more | 3,072 | one dominant |
| Richmond | 3,228 | Richmond (Virginia, 226,610); Richmond (California, 109,708); Richmond (Indiana, 35,854); +12 more | 4,386 | |
| Columbus | 3,171 | Columbus (Ohio, 913,175); Columbus (Georgia, 206,922); Columbus (Indiana, 46,690); +10 more | 3,081 | |
| Springfield | 3,159 | Springfield (Missouri, 170,188); Springfield (Massachusetts, 154,341); Springfield (Illinois, 114,394); +17 more | 4,037 | |
| Sunnyvale | 3,082 | Sunnyvale (California, 155,805); Sunnyvale (Texas, 6,044) | 2,365 | one dominant |
| Arlington | 3,022 | Arlington (Texas, 388,125); Arlington (Virginia, 207,627); Arlington (Massachusetts, 42,844); +9 more | 3,962 | |
| Louisville | 2,519 | Louisville (Kentucky, 624,444); Louisville (Colorado, 20,396); +6 more | 2,166 | one dominant |
| Las Vegas | 2,460 | Las Vegas (Nevada, 641,903); Las Vegas (New Mexico, 13,386) | 895 | one dominant |
| Mountain View | 2,399 | Mountain View (California, 80,435); Mountain View (Hawaii, 3,924); +5 more | 7,319 | one dominant |
| San Antonio | 2,399 | San Antonio (Texas, 1,526,656); San Antonio (Florida, 1,308) | 1,582 | one dominant |
| Redmond | 2,366 | Redmond (Washington, 60,598); Redmond (Oregon, 28,654) | 385 | |
| Raleigh | 2,307 | Raleigh (North Carolina, 482,295); Raleigh (Mississippi, 1,427) | 1,086 | one dominant |
| Bellevue | 2,250 | Bellevue (Washington, 139,820); Bellevue (Nebraska, 55,510); +10 more | 3,987 | |
| Minneapolis | 2,242 | Minneapolis (Minnesota, 410,939); Minneapolis (Kansas, 2,002) | 747 | one dominant |
| Portland | 2,137 | Portland (Oregon, 652,503); Portland (Maine, 66,881); +7 more | 4,081 | |
| Cambridge | 2,071 | Cambridge (Massachusetts, 110,402); Cambridge (Maryland, 12,507); +6 more | 2,425 | |

"New York" is ambiguous only because GeoNames calls the city "New York City", and "New York" is also listed as an alternate name of two small towns. The dominant-candidate rule gets it right. So does the state check.

### Largest ambiguous pairs, other countries

| Country | String | Placements | Candidates | Spread km |
|---|---|---:|---|---:|
| DE | Frankfurt | 1,032 | Frankfurt am Main (Hesse, 650,000); Frankfurt (Oder) (Brandenburg, 57,107) | 477 |
| CN | Suzhou | 785 | Suzhou (Jiangsu, 6,715,559); Suzhou (Anhui, 1,647,642) | 427 |
| CN | Shenzhen | 779 | Shenzhen (Guangdong, 17,494,398); Shenzhen (Guangdong, 5,029) | 306 |
| CA | Waterloo | 691 | Waterloo (Ontario, 104,986); Waterloo (Quebec, 4,410) | 668 |
| AU | Perth | 534 | Perth (Western Australia, 2,384,371); Perth (Tasmania, 2,907) | 2,967 |
| VN | Hanoi | 375 | Hanoi (Hanoi, 8,053,663); Hanoi (Hanoi, 0) | 79 |
| DE | Essen | 363 | Essen (North Rhine-Westphalia, 593,085); Essen (Lower Saxony, 8,185) | 154 |
| CN | Wuxi | 323 | Wuxi (Jiangsu, 4,396,835); Wuxi (Hunan, 66,442) | 988 |
| MX | Monterrey | 292 | Monterrey (Nuevo León, 1,135,512); Monterrey (Chiapas, 1,086) | 1,290 |
| BR | Campinas | 244 | Campinas (São Paulo, 1,031,554); Campinas (Santa Catarina, 20,000) | 544 |
| GB | Warrington | 230 | Warrington (England, 172,330); Warrington (England, 0) | 185 |
| MX | Nuevo León | 227 | three villages of that name; the string is the state | 2,882 |
| CR | San Jose | 202 | San José (San José, 335,007); San José (Alajuela, 31,430) | 161 |
| CA | Victoria | 198 | Victoria (British Columbia, 289,625); Victoria (Newfoundland and Labrador, 1,658) | 5,017 |

## Regions

350 pairs, 26,371 placements, which group into 273 regions. Most are states and provinces written where a city goes: Ontario 4,964, Karnataka 3,900, British Columbia 1,412, Telangana 1,282, Alberta 1,163. They don't belong on the map as points. They could be listed beside the map, like remote. The local spellings of German states, such as "Nordrhein-Westfalen" (903) and "Bayern" (495), fall through to unmatched because `admin1CodesASCII.txt` has English names only.

### Israeli regions

These become Ocean of Jobs' own entities, each with a list of member cities. None is a forced GeoNames match.

| Region | Placements | Strings seen |
|---|---:|---|
| Shfela | 740 | שפלה 373, השפלה 240, Shfela 127 |
| Sharon | 489 | שרון 260, Sharon 115, השרון 114 |
| Gush Dan | 418 | גוש דן 404, Gush Dan 14 |
| Center | 329 | Central District 132, Center 89, Center District 59, מרכז 25, HaMerkaz 9 |
| North | 292 | North 200, צפון 72, Northern District 13, North District 7 |
| South | 68 | דרום 36, South 28, South District 4 |
| Gush Etzion, Binyamin, Golan Heights, Jordan Valley | 23 | גוש עציון 8, מטה בנימין 8, במטה בנימין 2, רמת הגולן 3, איזור הבקעה 2 |

Member lists are a decision for the owner. Here is a first draft, based on common usage:

- **Gush Dan**: Tel Aviv-Yafo, Ramat Gan, Givatayim, Bnei Brak, Holon, Bat Yam, Petah Tikva, Or Yehuda, Kiryat Ono, Yehud.
- **Sharon**: Netanya, Herzliya, Ra'anana, Kfar Saba, Hod HaSharon, Ramat HaSharon, Even Yehuda, Kadima-Zoran.
- **Shfela**: Rishon LeZion, Rehovot, Ness Ziona, Yavne, Gedera, Lod, Ramla, Modiin, Beit Shemesh.
- **Center, North, South**: the Ministry of Interior districts, mapped to their cities from GeoNames admin1 codes.

## Unmatched

58,391 pairs, 232,649 placements, in 119 countries. Of these, 34,748 placements come from jobs naming more than one country. Those are the cross-product pairs, such as Sydney filed under GB, which are wrong pairs and should stay unmatched. The rest is mostly campus and site names, street addresses, postal codes and companies, plus country and state names in local languages: "Nederland" 2,318, "Nordrhein-Westfalen" 903, "Cataluña" 90.

| Country | Pairs | Placements | From multi-country jobs | Largest strings |
|---|---:|---:|---:|---|
| US | 34,171 | 134,679 | 2,628 | Main Campus 1,589; Coach 1,210; Client Site 975; New Orleans Region 891; J.Crew Factory 871; Space Coast 737 |
| GB | 3,027 | 13,062 | 4,883 | Sydney 686, all multi; NY 12208 505; City of 359; Berkshire 278; Victoria 230; Ontario 214 |
| DE | 1,591 | 7,738 | 1,588 | Nordrhein-Westfalen 903; Bayern 495; Hessen 296; Niedersachsen 282; bundesweit 205; London 153, all multi |
| CA | 1,975 | 7,713 | 2,171 | Washington 227, New York 172, San Francisco 120, Portland 103, Boston 87, all multi; Coach 104 |
| IN | 1,073 | 7,101 | 690 | STPI 443; MUFG Global Service Private Ltd. 184; BCIT 177; Gera Commerzone SEZ 166 |
| NL | 671 | 4,802 | 1,135 | Nederland 2,318; Noord-Brabant 217; London 117, all multi; Schiphol 79; Schiphol-Rijk 42 |
| FR | 1,366 | 4,322 | 1,056 | London 148, all multi; Nouvelle-Aquitaine 70; Nord 59; Hybride 53 |
| SG | 424 | 3,777 | 671 | NTU Main Campus 686; Fab 10N 367; Marina Bay Sands 293; Fab 10A 266; Central 228 |
| ES | 850 | 3,199 | 1,774 | London 126, all multi; de la Selva de Mar 103; 129 103; Cataluña 90; Catalunya 87 |
| PL | 680 | 2,829 | 1,308 | Mazowieckie 147; Masovian 96; Madrid 73, all multi; ul. Puławska 2 44 |
| AU | 725 | 2,678 | 777 | CBD & Inner Suburbs 132; Reading 127 and Berkshire 127, all multi; Barangaroo 60 |

## Israel

8,848 placements in 352 pairs, 103 of them from multi-country jobs, plus 101 remote jobs. No Israeli pair is ambiguous.

| Script | Exact | Alias | Region | Unmatched |
|---|---:|---:|---:|---:|
| Latin, placements | 4,491 | 859 | 812 | 350 |
| Hebrew, placements | 0 | 495 | 1,547 | 294 |

Hebrew strings never match exactly, because GeoNames names Israeli cities in Latin script. 67 Hebrew strings with 495 placements match through Hebrew alternate names, all correctly in the sample, for example רמלה, יהוד, באר יעקב, ראשון לציון, אילת, עפולה, בני ברק, נס ציונה, חדרה. Most Hebrew placements are regions: 1,547 of 2,336.

| String | Placements | Class | Matched to |
|---|---:|---|---|
| Tel Aviv | 2,387 | exact | Tel Aviv / תל אביב-יפו |
| גוש דן | 404 | region | Gush Dan |
| שפלה | 373 | region | Shfela |
| Yokneam | 343 | alias | Yoqneam moshava, wrong, see below |
| Herzliya | 324 | exact | Herzliya / הרצליה |
| Haifa | 303 | exact | Haifa / חיפה |
| Petah Tikva | 265 | alias | Petah Tiqva / פתח תקווה |
| שרון | 260 | region | Sharon |
| Raanana | 241 | exact | Ra'anana / רעננה |
| השפלה | 240 | region | Shfela |
| Jerusalem | 237 | exact | Jerusalem / ירושלים |
| Ramat Gan | 206 | exact | Ramat Gan / רמת גן |
| North | 200 | region | North |
| Ashdod | 180 | exact | Ashdod / אשדוד |
| נתב"ג | 171 | unmatched | Ben Gurion Airport, not a city |
| Central District | 132 | region | Center |
| Rehovot | 126 | exact | Rehovot / רחובות |
| יהוד | 105 | alias | Yehud |
| Netanya | 104 | exact | Netanya / נתניה |
| Beer Sheva | 97 | alias | Beersheba / באר שבע |

Israeli unmatched strings worth a small Ocean of Jobs alias table, because GeoNames can't help with them:

- **Abbreviations**: ת"א, פ"ת, ב"ש, ראשל"צ.
- **Sites that are places but not cities**: נתב"ג 171, Airport City 6, Kibbutz Shefayim 12, Tel Hai 8, הר חוצבים 4.
- **Small places below cities1000's 1,000-person cut**: Kfar Monash, Sarid.
- **West Bank settlements.** GeoNames files them under PS with feature code STLMT, so a search inside IL never finds them. Ma'ale Adumim, population 38,193, is geonameid 282993 under PS. Beitar Illit, Gush Etzion and Binyamin are the same case. The matcher should also search PS settlements for IL jobs.

The Yokneam match is wrong, and it has weight. "Yokneam" (343 placements) matched geonameid 11979661, the old moshava, population 1,398, labelled "יקנעם - מושבה". The postings mean Yokneam Illit, geonameid 293153, population 23,796, where the tech park is. The two points are about 2 km apart, so the dot would land close, but the label would be wrong. This pair was not in the random sample. It belongs in the Ocean of Jobs alias table, pointing at 293153.

## Location index size

Built from exact and alias pairs only. Points are merged by geonameid, so "Bangalore" and "Bengaluru" become one point. Each point carries its id, English name, Hebrew name where GeoNames has one, country, total, on-site and hybrid counts, and the board's own `city` filter values for that point, such as `IN:Bangalore,IN:Bengaluru`. That last field lets a click call the existing jobs API with no new endpoint. The largest point has 10 strings, below the API's limit of 20.

| Variant | Points | Raw | Gzip |
|---|---:|---:|---:|
| Long property names, 4 decimals | 17,192 | 3,834 KB | 626 KB |
| Short property names, 3 decimals | 17,192 | 2,967 KB | 587 KB |
| Short names, 3 decimals, no filter strings | 17,192 | 2,588 KB | 467 KB |
| Short names, filter strings, cities with at least 3 jobs | 10,574 | 1,852 KB | 370 KB |
| Short names, filter strings, cities with at least 10 jobs | 5,218 | 936 KB | 197 KB |

Remote per country adds 0.9 KB raw, 0.5 KB gzip. Three decimals place a point within about 100 m, which is plenty for a city. Hebrew names exist for 2,219 points. Resolving US ambiguity by state would add roughly 2,000 to 3,000 points, about 15% more bytes.

At 587 KB gzip, the full index likely costs more on first load than MapLibre itself. MapLibre's published bundle is roughly 220 KB gzip. I didn't measure it here. Cutting at 3 jobs halves it. Another option is two files, one with the 5,218 cities that have 10 or more jobs, loaded first, and the rest fetched in the background. That decision belongs with the map design.

### On-site and hybrid counts

Of the 600,791 placements at mapped cities, 25.7% are on-site, 6.5% hybrid, 2.4% remote, and 65.4% have no `workplace_type`. On-site and hybrid toggles would hide two thirds of the map's jobs. The index should carry an "unknown" count as well, or the toggles should be labelled as filtering only jobs that state their arrangement. Remote jobs that also name a city are counted at that city here. Whether they belong there or only in the remote count is a decision to make.

## Upstream issues found on the way

These affect the board as well as the map.

1. **293,654 open jobs have no country.** That is 22% of open jobs, and none of them can be mapped.
2. **"CA" read as California.** "CA, Ontario, Brockville" was filed under the US.
3. **US jobs filed under GB.** "Torrington, CT" is one example. "NY 12208" is another, with 505 placements under GB.
4. **The country-city cross product.** It files 59,056 placements under countries the city isn't in. `api/aggregates.py` documents this already. It looks like more than "nearly none": "Sydney" under GB has 686.
5. **US cities stored without a state.** This one change turns 72% of the ambiguous US jobs into exact matches.
6. **Provinces and states stored as cities.** "Quebec", "Ontario", "Karnataka", "Nuevo León". `_canonical_city` keeps any unknown segment longer than two letters.

## Suggested decisions before step 2

1. Map exact matches as they are.
2. Map aliases only from tagged, non-historic alternate names: all languages from `alternateNamesV2`, not just Hebrew and English, still skipping `isHistoric`. Leave untagged aliases off the map, or review them by hand. They are 29,460 placements.
3. Treat a string that equals a first-level region name in its country as a region, even when a city has the same name, unless the raw location puts it first. That fixes Quebec. It needs care for city-states and capitals such as Tokyo and Madrid, where the region carries the same name as the city.
4. Resolve US ambiguity with the state from the raw location, at write time in `loader/`, or in the index generator by reading `location`. For the 25% with no state, either take the dominant candidate or leave them off. Count whichever is chosen in the manifest.
5. Build the Israeli region entities from the draft above. Show them as a list beside the map, like remote, not as points. Add a small Ocean of Jobs alias table for the Hebrew abbreviations, Yokneam and the airport, and search PS settlements for IL jobs.
6. Add an "unknown arrangement" count, or relabel the on-site and hybrid toggles.

## Not checked

- The samples cover exact and alias matches only. Region and unmatched classes were reviewed by reading the largest strings, not sampled.
- The US state check covers single-city, single-country US jobs, 231,921 of them. Multi-city US rows were not tested.
- Counts move by a few dozen between runs, because the box applies new fragments while the 72 partition queries run. No partition is internally inconsistent.
- No map, index file, tiles or UI were built. So no assumption about the `apply/src/site` conventions was made, and this report proposes none.
