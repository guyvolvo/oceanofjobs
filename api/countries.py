"""One country per location string, from whatever the ATS happened to write.

There is no country field to read. Every board writes location as free
text and no two agree, so this file is the place where "München, de",
"Remote, United Kingdom", "Tel Aviv-Yafo, Tel Aviv, ISR" and "Prague"
all become a country code.

Shared by probe.py, which tags jobs as they are scraped, and the API,
which filters on the result. One definition, for the same reason
skills.py exists: two copies of a vocabulary disagree within minutes.

The ordering of the rules below is the whole design, and it comes from
counting 1,500 real locations rather than from taste:

  lowercase two-letter   us 318, ca 52, pl 25, fr 19  -- always a country
  UPPERCASE two-letter   CA 73, NY 35, DC 20, IL 4    -- almost always a US state
  UPPERCASE three-letter USA 20, CUN 7, NYC 4         -- countries AND airport codes

That second row is the trap, and it is pointed straight at this board.
Every bare uppercase IL in the data is Chicago, Illinois; not one is
Israel. A resolver that reads two-letter codes as countries turns every
Chicago listing into an Israeli one, on a site whose entire premise is
Israeli listings. So a US state code is the last rule tried, and only
after the city has had its say: "Chicago, IL" resolves through Chicago,
and "Tel Aviv, IL" through Tel Aviv, and neither needs the state rule at
all.

Airport codes are why alpha-3 is an allowlist rather than a computed
set. CUN and SEA and NYC all look exactly like country codes.
"""

import re
import unicodedata

# Rule 1. Names and the aliases people actually write. Lowercased keys.
COUNTRY_NAMES = {
    "israel": "IL", "state of israel": "IL", "ישראל": "IL", "מדינת ישראל": "IL",
    "united states": "US", "united states of america": "US", "usa": "US",
    "u.s.": "US", "u.s.a.": "US", "america": "US",
    "united kingdom": "GB", "great britain": "GB", "britain": "GB",
    "england": "GB", "scotland": "GB", "wales": "GB", "northern ireland": "GB",
    "germany": "DE", "deutschland": "DE",
    "france": "FR", "spain": "ES", "portugal": "PT", "italy": "IT",
    "netherlands": "NL", "the netherlands": "NL", "holland": "NL",
    "belgium": "BE", "luxembourg": "LU", "ireland": "IE", "republic of ireland": "IE",
    "switzerland": "CH", "austria": "AT", "denmark": "DK", "sweden": "SE",
    "norway": "NO", "finland": "FI", "iceland": "IS", "estonia": "EE",
    "latvia": "LV", "lithuania": "LT", "poland": "PL",
    "czechia": "CZ", "czech republic": "CZ", "slovakia": "SK", "hungary": "HU",
    "romania": "RO", "bulgaria": "BG", "greece": "GR", "cyprus": "CY",
    "croatia": "HR", "slovenia": "SI", "serbia": "RS", "ukraine": "UA",
    "turkey": "TR", "türkiye": "TR", "russia": "RU",
    "canada": "CA", "mexico": "MX", "brazil": "BR", "brasil": "BR",
    "argentina": "AR", "chile": "CL", "colombia": "CO", "peru": "PE",
    "uruguay": "UY", "costa rica": "CR", "panama": "PA", "dominican republic": "DO",
    "india": "IN", "china": "CN", "hong kong": "HK", "taiwan": "TW",
    "japan": "JP", "south korea": "KR", "korea": "KR", "republic of korea": "KR",
    "singapore": "SG", "malaysia": "MY", "thailand": "TH", "vietnam": "VN",
    "viet nam": "VN", "indonesia": "ID", "philippines": "PH", "pakistan": "PK",
    "bangladesh": "BD", "sri lanka": "LK",
    "australia": "AU", "new zealand": "NZ",
    "united arab emirates": "AE", "uae": "AE", "saudi arabia": "SA",
    "qatar": "QA", "bahrain": "BH", "kuwait": "KW", "jordan": "JO",
    "egypt": "EG", "morocco": "MA", "tunisia": "TN", "south africa": "ZA",
    "kenya": "KE", "nigeria": "NG", "ghana": "GH", "ethiopia": "ET",
    "mauritius": "MU", "armenia": "AM",
    "maldives": "MV", "tanzania": "TZ", "kazakhstan": "KZ", "uzbekistan": "UZ",
    "azerbaijan": "AZ", "belarus": "BY", "moldova": "MD", "albania": "AL",
    "north macedonia": "MK", "bosnia and herzegovina": "BA", "montenegro": "ME",
    "malta": "MT", "monaco": "MC", "andorra": "AD", "liechtenstein": "LI",
    "guatemala": "GT", "honduras": "HN", "el salvador": "SV", "nicaragua": "NI",
    "bolivia": "BO", "paraguay": "PY", "ecuador": "EC", "venezuela": "VE",
    "jamaica": "JM", "trinidad and tobago": "TT", "barbados": "BB",
    "senegal": "SN", "rwanda": "RW", "uganda": "UG", "zambia": "ZM",
    "algeria": "DZ", "oman": "OM", "lebanon": "LB", "nepal": "NP",
    "myanmar": "MM", "cambodia": "KH", "mongolia": "MN", "fiji": "FJ",
    # The country in its own language. Listed after the English names, so
    # the label each code shows is still the English one. "Utrecht,
    # Utrecht, Nederland" used to carry no country at all.
    "nederland": "NL", "españa": "ES", "italia": "IT", "polska": "PL",
    "schweiz": "CH", "suisse": "CH", "svizzera": "CH", "österreich": "AT",
    "sverige": "SE", "norge": "NO", "danmark": "DK", "suomi": "FI",
    "česko": "CZ", "česká republika": "CZ", "magyarország": "HU",
    "belgië": "BE", "belgique": "BE",
}

# The Israel-only filter's own keyword list, matched as a plain substring
# anywhere in the location. It lives here rather than in job_filters
# because countries_of has to agree with it exactly: a listing the board
# calls Israeli and a country filter that disagrees are two answers to
# one question, and the one people notice is the smaller number.
# Reported live: country=IL returned 662 where israel_only returned
# 2,464. job_filters re-exports it, so every existing caller is
# unchanged.
# Places whose name contains an Israeli keyword and are not in Israel.
#
# Reported live: 1,075 listings at bilh.myworkdayjobs.com, the Beth
# Israel Lahey Health hospital network, were counted as Israeli because
# the bare keyword "israel" matched "Beth Israel Deaconess Medical
# Center" sitting in the location string. That is 1,075 of what the
# board called 7,591 Israeli jobs, so the real figure was about 6,496
# and the headline number was overstated by a sixth.
#
# Checked before the keywords rather than after, and matched on the
# phrase, so a genuine Israeli location is untouched: nothing here
# removes "Israel" on its own, only a longer name that happens to
# contain it.
#
# This is a list of names, not a rule, because there is no rule. "Beth
# Israel" is a hospital in Boston and "Israel Discount Bank" is an
# Israeli bank with a New York branch. Only the ones actually seen in
# real location strings go here.
IL_FALSE_FRIENDS = ("beth israel",)


def _without_false_friends(location: str) -> str:
    low = location.lower()
    for name in IL_FALSE_FRIENDS:
        if name in low:
            # Case-insensitively, keeping the rest of the string intact
            # so every other segment still reads the way it was written.
            location = re.sub(re.escape(name), " ", location, flags=re.IGNORECASE)
    return location


def matches_israel(location: str | None) -> bool:
    """Whether this location names somewhere in Israel.

    The one question israel_only and country=IL both have to answer the
    same way. See IL_KEYWORDS, and IL_FALSE_FRIENDS for why it is not
    just a substring search.
    """
    if not location:
        return False
    return any(kw in _without_false_friends(location).lower() for kw in IL_KEYWORDS)


IL_KEYWORDS = [
    "israel", "tel aviv", "tel-aviv", "telaviv", "herzliya", "raanana", "ra'anana",
    "rehovot", "netanya", "haifa", "jerusalem", "beer sheva", "beersheva",
    "petah tikva", "petah-tikva", "yokneam", "kfar saba", "kfar-saba",
    "ramat gan", "ramat-gan", "modiin", "modi'in",
    "caesarea", "yavne", "hod hasharon", "hod-hasharon", "bnei brak", "bnei-brak",
    "rosh haayin", "rosh-haayin", "tlv",
    # Added after finding these unmatched in real location strings.
    # "kiryat" ("town of") deliberately catches every Kiryat-prefixed city
    # in one entry. "Azur" was deliberately left out: too easily a false
    # match against "Azure" the technology.
    #
    # Every multi-word city above now has a hyphenated form too, not just
    # Tel Aviv -- reported live: "Ramat-Gan" (Sisense's own ATS location
    # string, hyphenated) didn't match the space-only "ramat gan" entry,
    # so a real Israeli listing was silently excluded from israel_only.
    "givatayim", "karmiel", "kiryat", "rishon", "yehud",
]


# Rule 2. Alpha-3, allowlisted rather than computed, because CUN, NYC and
# SEA are airport codes that look identical to one.
COUNTRY_ALPHA3 = {
    "ISR": "IL", "USA": "US", "GBR": "GB", "DEU": "DE", "FRA": "FR",
    "ESP": "ES", "PRT": "PT", "ITA": "IT", "NLD": "NL", "BEL": "BE",
    "LUX": "LU", "IRL": "IE", "CHE": "CH", "AUT": "AT", "DNK": "DK",
    "SWE": "SE", "NOR": "NO", "FIN": "FI", "ISL": "IS", "EST": "EE",
    "LVA": "LV", "LTU": "LT", "POL": "PL", "CZE": "CZ", "SVK": "SK",
    "HUN": "HU", "ROU": "RO", "BGR": "BG", "GRC": "GR", "CYP": "CY",
    "HRV": "HR", "SVN": "SI", "SRB": "RS", "UKR": "UA", "TUR": "TR",
    "CAN": "CA", "MEX": "MX", "BRA": "BR", "ARG": "AR", "CHL": "CL",
    "COL": "CO", "PER": "PE", "URY": "UY", "CRI": "CR", "PAN": "PA",
    "IND": "IN", "CHN": "CN", "HKG": "HK", "TWN": "TW", "JPN": "JP",
    "KOR": "KR", "SGP": "SG", "MYS": "MY", "THA": "TH", "VNM": "VN",
    "IDN": "ID", "PHL": "PH", "PAK": "PK", "BGD": "BD", "LKA": "LK",
    "AUS": "AU", "NZL": "NZ", "ARE": "AE", "SAU": "SA", "QAT": "QA",
    "EGY": "EG", "MAR": "MA", "ZAF": "ZA", "KEN": "KE", "NGA": "NG",
    "GEO": "GE", "ARM": "AM", "AZE": "AZ", "KAZ": "KZ", "MDV": "MV",
}

# Rule 3. Lowercase alpha-2, which is one ATS's own convention and is
# reliable precisely because it is lowercase. Only the codes above are
# accepted, so a stray "hi" or "ok" is not a country.
ALPHA2 = set(COUNTRY_NAMES.values()) | set(COUNTRY_ALPHA3.values())

# Rule 4. Cities that appear with no country beside them. Israel's list
# is the one that has to be complete, since it decides this board's
# headline filter; the rest are the cities the data actually shows.
CITIES = {
    # Israel
    "tel aviv": "IL", "tel aviv-yafo": "IL", "tel-aviv": "IL", "telaviv": "IL",
    "jerusalem": "IL", "haifa": "IL", "herzliya": "IL", "herzliya pituach": "IL",
    "raanana": "IL", "ra'anana": "IL", "petah tikva": "IL", "petach tikva": "IL",
    "netanya": "IL", "rehovot": "IL", "ramat gan": "IL", "givatayim": "IL",
    "beer sheva": "IL", "be'er sheva": "IL", "beersheba": "IL", "yokneam": "IL",
    "yokneam illit": "IL", "יקנעם": "IL", "יקנעם עילית": "IL",
    "kiryat gat": "IL", "caesarea": "IL", "modiin": "IL", "ashdod": "IL",
    "holon": "IL", "bnei brak": "IL", "airport city": "IL", "rosh haayin": "IL",
    "or yehuda": "IL", "kfar saba": "IL", "hod hasharon": "IL", "migdal haemek": "IL",
    # Hebrew. Niloosoft and the Israeli boards write locations in it, and
    # an unmatched Hebrew string used to mean no city and no country at
    # all, on exactly the listings this board exists for. The regional
    # ones are regions rather than cities, kept as themselves rather than
    # forced into a nearby city they are not.
    "תל אביב": "IL", "תל־אביב": "IL",
    "ירושלים": "IL", "חיפה": "IL",
    "הרצליה": "IL", "רעננה": "IL",
    "פתח תקווה": "IL", "נתניה": "IL",
    "רחובות": "IL", "רמת גן": "IL",
    "באר שבע": "IL", "אשדוד": "IL",
    "חולון": "IL", "כפר סבא": "IL",
    "אזור המרכז": "IL", "אזור השפלה": "IL",
    "אזור השרון": "IL", "אזור הצפון": "IL",
    "אזור הדרום": "IL",
    "ירושלים והסביבה": "IL",
    # United States
    "new york": "US", "new york city": "US", "nyc": "US", "brooklyn": "US",
    "san francisco": "US", "palo alto": "US", "mountain view": "US",
    "sunnyvale": "US", "santa clara": "US", "san jose": "US", "cupertino": "US",
    "seattle": "US", "bellevue": "US", "redmond": "US", "austin": "US",
    "chicago": "US", "denver": "US", "boston": "US", "atlanta": "US",
    "dallas": "US", "houston": "US", "miami": "US", "los angeles": "US",
    "san diego": "US", "philadelphia": "US", "phoenix": "US", "portland": "US",
    "washington": "US", "washington dc": "US", "pittsburgh": "US",
    "minneapolis": "US", "detroit": "US", "nashville": "US", "raleigh": "US",
    # Rest of the world
    "london": "GB", "cambridge, uk": "GB", "manchester": "GB", "edinburgh": "GB",
    "dublin": "IE", "paris": "FR", "toulouse": "FR", "lyon": "FR",
    "berlin": "DE", "munich": "DE", "münchen": "DE", "hamburg": "DE",
    "frankfurt": "DE", "cologne": "DE", "köln": "DE", "stuttgart": "DE",
    "amsterdam": "NL", "rotterdam": "NL", "eindhoven": "NL",
    "brussels": "BE", "zurich": "CH", "zürich": "CH", "geneva": "CH",
    "vienna": "AT", "prague": "CZ", "praha": "CZ", "brno": "CZ",
    "warsaw": "PL", "warszawa": "PL", "krakow": "PL", "kraków": "PL",
    "wroclaw": "PL", "gdansk": "PL", "budapest": "HU", "bucharest": "RO",
    "sofia": "BG", "belgrade": "RS", "zagreb": "HR", "ljubljana": "SI",
    "athens": "GR", "lisbon": "PT", "porto": "PT", "madrid": "ES",
    "barcelona": "ES", "valencia": "ES", "milan": "IT", "rome": "IT",
    "stockholm": "SE", "gothenburg": "SE", "copenhagen": "DK", "oslo": "NO",
    "helsinki": "FI", "tallinn": "EE", "riga": "LV", "vilnius": "LT",
    "kyiv": "UA", "kiev": "UA", "istanbul": "TR", "tbilisi": "GE",
    "toronto": "CA", "vancouver": "CA", "montreal": "CA", "ottawa": "CA",
    "waterloo": "CA", "calgary": "CA",
    "mexico city": "MX", "ciudad de méxico": "MX", "ciudad de mexico": "MX",
    "cdmx": "MX", "guadalajara": "MX", "sao paulo": "BR",
    "são paulo": "BR", "rio de janeiro": "BR", "buenos aires": "AR",
    "santiago": "CL", "bogota": "CO", "bogotá": "CO", "lima": "PE",
    "bangalore": "IN", "bengaluru": "IN", "mumbai": "IN", "pune": "IN",
    "hyderabad": "IN", "chennai": "IN", "gurgaon": "IN", "gurugram": "IN",
    "noida": "IN", "new delhi": "IN", "delhi": "IN",
    "tokyo": "JP", "osaka": "JP", "seoul": "KR", "taipei": "TW",
    "shanghai": "CN", "beijing": "CN", "shenzhen": "CN", "hong kong": "HK",
    "singapore": "SG", "kuala lumpur": "MY", "bangkok": "TH",
    "ho chi minh city": "VN", "hanoi": "VN", "jakarta": "ID", "manila": "PH",
    "sydney": "AU", "melbourne": "AU", "brisbane": "AU", "auckland": "NZ",
    "dubai": "AE", "abu dhabi": "AE", "riyadh": "SA", "doha": "QA",
    "cairo": "EG", "casablanca": "MA", "nairobi": "KE", "lagos": "NG",
    "cape town": "ZA", "johannesburg": "ZA",
}

# Rule 5, last and only if nothing above fired. Half of these collide
# with a country code, which is exactly why they are last: IL is
# Illinois far more often than it is Israel, in this data always.
US_STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
    "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
    "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
    "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
    "WI", "WY", "DC", "PR",
}

# Spelled out, because "Lehi, Utah" and "Berthoud, Colorado" are how
# some boards write a US address and neither carries a country anywhere.
US_STATE_NAMES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
    "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana",
    "maine", "maryland", "massachusetts", "michigan", "minnesota",
    "mississippi", "missouri", "montana", "nebraska", "nevada",
    "new hampshire", "new jersey", "new mexico", "new york state",
    "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
    "pennsylvania", "rhode island", "south carolina", "south dakota",
    "tennessee", "texas", "utah", "vermont", "virginia", "washington state",
    "west virginia", "wisconsin", "wyoming", "puerto rico",
}

# The same states by code, for places_of, which keeps the state beside its
# city. "Austin" alone is four places in the US; "Austin, TX" is one.
US_STATE_CODES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
    "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE",
    "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
    "new york": "NY", "new york state": "NY", "north carolina": "NC",
    "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR",
    "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
    "vermont": "VT", "virginia": "VA", "washington": "WA", "washington state": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
    "district of columbia": "DC", "puerto rico": "PR",
}

# Rule 4b. First-level regions outside the US: provinces, states, Länder.
# Boards write them where a city goes ("Montreal, Quebec", "Bengaluru,
# Karnataka", "Utrecht, Nederland") and they used to land in the city
# filter as cities, Ontario alone with about 5,000 open jobs. A region
# names its country, so it answers the country question, and it is never a
# city. Only names that are not also a city somewhere the board lists are
# here; the ones that are both sit in ADMIN1_IN_COUNTRY below. Quebec is
# deliberately a region: counted on the live data it is "Montreal, Quebec"
# nearly every time, not Quebec City, which boards write as "Quebec City".
ADMIN1 = {
    "CA": ["ontario", "quebec", "québec", "british columbia", "alberta", "manitoba",
           "saskatchewan", "nova scotia", "new brunswick", "newfoundland and labrador",
           "prince edward island", "yukon", "nunavut", "northwest territories"],
    "AU": ["new south wales", "queensland", "western australia", "south australia",
           "tasmania", "australian capital territory", "northern territory"],
    "IN": ["karnataka", "telangana", "maharashtra", "tamil nadu", "haryana",
           "uttar pradesh", "gujarat", "kerala", "west bengal", "andhra pradesh",
           "rajasthan", "madhya pradesh", "odisha", "bihar", "assam", "jharkhand",
           "chhattisgarh", "uttarakhand", "himachal pradesh"],
    "DE": ["bavaria", "bayern", "hesse", "hessen", "saxony", "sachsen", "lower saxony",
           "niedersachsen", "north rhine-westphalia", "north rhine westphalia",
           "nordrhein-westfalen", "nrw", "baden-württemberg", "baden württemberg",
           "rhineland-palatinate", "rheinland-pfalz", "schleswig-holstein", "thuringia",
           "thüringen", "saxony-anhalt", "sachsen-anhalt", "mecklenburg-vorpommern", "saarland"],
    "NL": ["noord-holland", "zuid-holland", "noord-brabant", "north holland", "south holland",
           "north brabant", "gelderland", "overijssel", "friesland", "drenthe", "flevoland",
           "zeeland"],
    "ES": ["cataluña", "catalunya", "catalonia", "andalucía", "andalusia", "comunidad de madrid",
           "community of madrid", "país vasco", "basque country", "galicia",
           "comunidad valenciana", "valencian community", "castilla y león", "aragón",
           "navarra", "cantabria", "canarias", "canary islands", "islas baleares",
           "balearic islands", "extremadura", "castilla-la mancha"],
    "IT": ["lombardia", "lombardy", "lazio", "piemonte", "piedmont", "veneto", "emilia-romagna",
           "toscana", "tuscany", "campania", "sicilia", "sicily", "puglia", "apulia", "liguria",
           "sardegna", "sardinia", "friuli-venezia giulia", "trentino-alto adige", "abruzzo",
           "calabria", "umbria"],
    "PL": ["mazowieckie", "masovian", "mazovia", "małopolskie", "lesser poland", "śląskie",
           "silesia", "silesian", "dolnośląskie", "lower silesia", "wielkopolskie",
           "greater poland", "pomorskie", "pomerania", "łódzkie", "łódź voivodeship"],
    "MX": ["nuevo león", "jalisco", "estado de méxico", "baja california", "sonora", "coahuila",
           "yucatán", "quintana roo", "tamaulipas", "sinaloa"],
    "BR": ["minas gerais", "paraná", "rio grande do sul", "santa catarina", "bahia",
           "pernambuco", "goiás", "ceará", "espírito santo"],
    "CN": ["jiangsu", "guangdong", "zhejiang", "sichuan", "shandong", "hubei", "fujian", "henan",
           "hunan", "anhui", "liaoning", "shaanxi", "hebei"],
    "ZA": ["western cape", "gauteng", "kwazulu-natal", "eastern cape"],
    "IE": ["leinster", "munster", "connacht", "connaught"],
    "PH": ["national capital region", "metro manila", "calabarzon", "central luzon",
           "central visayas"],
    "ID": ["jawa barat", "west java", "jawa tengah", "central java", "jawa timur", "east java",
           "banten", "dki jakarta"],
    "FR": ["île-de-france", "auvergne-rhône-alpes", "provence-alpes-côte d'azur",
           "nouvelle-aquitaine", "occitanie", "hauts-de-france", "grand est", "bretagne",
           "brittany", "normandie", "normandy", "pays de la loire", "bourgogne-franche-comté",
           "centre-val de loire"],
}

# Regions whose name is also a city or a region somewhere else. Each is a
# region only when the same group already names one of these countries:
# "Melbourne, Victoria, Australia" drops Victoria, "Victoria, BC" keeps it.
# On their own they say nothing about the country.
ADMIN1_IN_COUNTRY = {
    "victoria": ("AU",), "limburg": ("NL", "BE"), "la rioja": ("ES", "AR"),
    "distrito federal": ("MX", "BR"), "punjab": ("IN", "PK"), "goa": ("IN",),
    "brandenburg": ("DE",), "santa cruz": ("AR",),
}

# Province and state codes outside the US, used like the US state codes:
# last, and only when nothing better is in the group. Codes that are also a
# country written in capitals (NL, PE, SK, NT) are left out.
PROVINCE_CODES = {
    "AB": "CA", "BC": "CA", "MB": "CA", "NB": "CA", "NS": "CA", "ON": "CA", "QC": "CA",
    "YT": "CA", "NU": "CA",
    "NSW": "AU", "QLD": "AU", "VIC": "AU", "TAS": "AU", "ACT": "AU",
}

# Written by people, not machines, so a country can be spelled out mid
# sentence: "Remote - France", "Remote (Israel)".
_SPLIT = re.compile(r"[;|/,\n()\[\]]+|\s+-\s+")
_ALPHA2_RE = re.compile(r"^[a-z]{2}$")
_ALPHA3_RE = re.compile(r"^[A-Z]{3}$")
_UPPER2_RE = re.compile(r"^[A-Z]{2}$")


def _norm(text: str) -> str:
    """Fold everything that makes one place look like two.

    "Ramat-Gan" and "Ramat Gan" were two separate entries in the filter
    for one city, and so were Montreal and Montreal with its accent.
    Accents come off, hyphens and apostrophes go, runs of space collapse.
    """
    folded = unicodedata.normalize("NFKD", text)
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    for ch in ("-", "_", "־", "‐", "‑", "–", "—"):
        folded = folded.replace(ch, " ")
    folded = folded.replace("'", "").replace("’", "")
    return " ".join(folded.lower().split())

# Longest first, so "united states" wins over "united" and "new york
# state" over "new york". Word-bounded, or "india" matches "indiana" and
# "chile" matches nothing good either.
def _fold_keys(mapping: dict) -> dict:
    return {_norm(k): v for k, v in mapping.items()}


CITIES_FOLDED = _fold_keys(CITIES)
COUNTRY_NAMES_FOLDED = _fold_keys(COUNTRY_NAMES)
US_STATE_NAMES_FOLDED = {_norm(x) for x in US_STATE_NAMES}
US_STATE_CODES_FOLDED = _fold_keys(US_STATE_CODES)
ADMIN1_FOLDED = {_norm(name): code for code, names in ADMIN1.items() for name in names}
ADMIN1_IN_COUNTRY_FOLDED = _fold_keys(ADMIN1_IN_COUNTRY)
# Two states share their name with a city the board lists. After a city in
# the same group they are the state: "Seattle, Washington", "Brooklyn, New York".
_US_STATE_CITIES = {"washington", "new york"}

# A US state stuck to the end of a city or to the front of a ZIP code, with
# no comma: "Erie PA, 16502", "Newton-MA", "NY 12208".
_STATE_SUFFIX_RE = re.compile(r"^(.*[^\W\d_])[\s-]+([A-Z]{2})$")
_STATE_ZIP_RE = re.compile(r"^([A-Z]{2})\s+\d{5}(?:-\d{4})?\b")


def _us_state_code(seg: str) -> str | None:
    """A US state written as a code: "TX", "D.C."."""
    raw = seg.strip().replace(".", "")
    return raw if _UPPER2_RE.match(raw) and raw in US_STATES else None


def _admin1_country(seg: str, following: str = "") -> str | None:
    """The country of a region named in ADMIN1, or None.

    "Ontario, CA" and "Ontario, California" are the city in California, not
    the province, so a region written first and followed by a US state is
    no region at all. Callers pass `following` only for the first segment:
    in "Toronto, Ontario, CA" the CA is Canada and Ontario the province.
    """
    code = ADMIN1_FOLDED.get(_norm(seg.strip().strip(".")))
    if code and following and (_us_state_code(following) or _norm(following) in US_STATE_CODES_FOLDED):
        return None
    return code

_PHRASE_RE = re.compile(
    r"\b(?:" + "|".join(
        re.escape(n) for n in sorted(
            set(COUNTRY_NAMES_FOLDED) | US_STATE_NAMES_FOLDED | {"us", "uk", "usa"},
            key=len, reverse=True)
    ) + r")\b")

# What to call a code on screen. Built from the names above rather than
# typed twice: the first spelling listed for each code is the canonical
# one, which is why "united states" is written before "usa" and
# "czechia" before "czech republic".
def _label(name: str) -> str:
    small = {"and", "of", "the"}
    return " ".join(w if w in small else w.capitalize() for w in name.split())


COUNTRY_LABELS: dict[str, str] = {}
for _name, _code in COUNTRY_NAMES.items():
    COUNTRY_LABELS.setdefault(_code, _label(_name))
COUNTRY_LABELS["US"] = "United States"
COUNTRY_LABELS["GB"] = "United Kingdom"
COUNTRY_LABELS["AE"] = "United Arab Emirates"
COUNTRY_LABELS["KR"] = "South Korea"
COUNTRY_LABELS["CZ"] = "Czechia"
COUNTRY_LABELS["GE"] = "Georgia"


def label_for(code: str) -> str:
    """A country's display name, falling back to the code itself so an
    unlabelled one shows as "MV" rather than vanishing from a filter."""
    return COUNTRY_LABELS.get(code, code)


MAX_COUNTRIES = 8


def _segment_country(seg: str) -> str | None:
    raw = seg.strip().strip(".")
    if not raw:
        return None
    low = _norm(raw)

    if low in COUNTRY_NAMES_FOLDED:
        return COUNTRY_NAMES_FOLDED[low]
    if _ALPHA3_RE.match(raw) and raw in COUNTRY_ALPHA3:
        return COUNTRY_ALPHA3[raw]
    if _ALPHA2_RE.match(raw) and raw.upper() in ALPHA2:
        return raw.upper()
    if low in CITIES_FOLDED:
        return CITIES_FOLDED[low]
    # "Remote, United Kingdom" already matched above; this catches a city
    # written with its own qualifier, like "Herzliya Pituach Office".
    for city, code in CITIES_FOLDED.items():
        if low.startswith(city + " ") or low.endswith(" " + city):
            return code
    if raw == "UK":
        return "GB"
    if raw == "US":
        return "US"
    if low in US_STATE_NAMES_FOLDED:
        return "US"
    # Last within the segment: a country or state named inside a phrase.
    # "US Remote", "Ukraine Office", "All France (remote)" are all one
    # segment with the answer sitting in the middle of it.
    m = _PHRASE_RE.search(low)
    if m:
        name = m.group(0)
        if name in ("us", "u.s.", "usa"):
            return "US"
        if name == "uk":
            return "GB"
        return COUNTRY_NAMES_FOLDED.get(name) or ("US" if name in US_STATE_NAMES_FOLDED else None)
    return None


def countries_of(location: str | None) -> list[str]:
    """Every country a location string names, in the order written.

    Deduped: "Remote, Israel; Tel Aviv, Israel" is one country, not two,
    and a job listing four offices in the same country is one entry in
    the filter rather than four.
    """
    if not location:
        return []
    # Before anything reads a segment. "Beth Israel Deaconess Medical
    # Center" is one segment and _segment_country finds the country name
    # inside it, so the keyword fallback further down never gets a say.
    # See IL_FALSE_FRIENDS.
    location = _without_false_friends(location)
    out: list[str] = []
    # Semicolons separate whole locations; everything else separates the
    # parts of one. Both are split the same way here because a country
    # found anywhere in a group belongs to the job either way.
    groups = [g for g in location.split(";") if g.strip()] or [location]
    for group in groups:
        segments = [s for s in _SPLIT.split(group) if s.strip()]
        found: list[str] = []
        state_fallback = province_fallback = None
        for i, seg in enumerate(segments):
            following = segments[1] if i == 0 and len(segments) > 1 else ""
            code = _segment_country(seg) or _admin1_country(seg, following)
            if code:
                # Every country in the group, not just the first.
                # Stopping at the first was correct for an address, where
                # the later segments only restate the same place, and
                # wrong for a job posted in ten offices at once: only
                # semicolons started a new group, and these boards
                # separate with commas, so "Zurich, Switzerland,
                # Brussels, Belgium, ... Tel Aviv-Yafo, Israel" reported
                # Switzerland and nothing else. Found by 7 listings the
                # Israel-only filter matched and the country filter did
                # not. Deduplicated, so an address still counts once.
                if code not in found:
                    found.append(code)
                continue
            s = seg.strip()
            if s in PROVINCE_CODES:
                province_fallback = province_fallback or PROVINCE_CODES[s]
            elif _us_state_code(s) or (_STATE_ZIP_RE.match(s) and s[:2] in US_STATES) or (
                    (m := _STATE_SUFFIX_RE.match(s)) and m.group(2) in US_STATES):
                state_fallback = "US"
        # A Canadian or Australian province code beats a US state code in
        # the same group: "Brockville, ON, CA" is Canada, and its CA is too.
        fallback = province_fallback or state_fallback
        for code in (found or ([fallback] if fallback else [])):
            if code not in out:
                out.append(code)

    # Last resort, over the whole string rather than one segment at a
    # time. Everything above needs a segment to line up with a rule, and
    # a location like "Hybrid Kiryat Ono" or "R&D Center, Yehud" lines up
    # with nothing while still plainly naming a place.
    #
    # The Israeli list first, because it is the one that has to match
    # exactly. israel_only reads the same keywords as a plain substring
    # anywhere in the string, so anything it calls Israeli this has to
    # call Israeli too. Reported live: the country filter returned 662
    # where israel_only returned 2,464, which reads as the filter being
    # broken rather than stricter, and it was the same question answered
    # two ways.
    # Checked whatever else was found, not only when nothing was, and
    # before the cap below. A posting listing a dozen offices must still
    # be findable under Israel, which is the one country this board
    # cannot afford to be approximate about.
    if "IL" not in out and matches_israel(location):
        out.insert(0, "IL")
    if not out:
        m = _PHRASE_RE.search(_norm(location))
        if m:
            name = m.group(0)
            code = ("US" if name in ("us", "usa") or name in US_STATE_NAMES_FOLDED
                    else "GB" if name == "uk"
                    else COUNTRY_NAMES_FOLDED.get(name))
            if code:
                out.append(code)
    return out[:MAX_COUNTRIES]


def country_string(location: str | None) -> str:
    """The stored form: comma-joined, no spaces, same shape as skills."""
    return ",".join(countries_of(location))


# The city half of the same problem, and the reason the filter can be one
# dropdown instead of two.
#
# Raw location strings spell one city many ways: "Tel Aviv", "Tel
# Aviv-Yafo, Tel Aviv, ISR", "tel-aviv", "Tel Aviv, Israel". Faceting on
# the raw string offers all four as separate options for the same place,
# which is the duplication this exists to remove. A gazetteer hit
# collapses them to one name; anything else keeps its own first segment,
# so a city we have never heard of still appears rather than vanishing.
CITY_ALIASES = {
    "tel aviv-yafo": "Tel Aviv", "tel-aviv": "Tel Aviv", "telaviv": "Tel Aviv",
    "ra'anana": "Raanana", "petach tikva": "Petah Tikva",
    "be'er sheva": "Beer Sheva", "beersheba": "Beer Sheva",
    "herzliya pituach": "Herzliya", "rosh haayin": "Rosh HaAyin",
    "new york city": "New York", "nyc": "New York",
    "washington dc": "Washington",
    "münchen": "Munich", "köln": "Cologne", "zürich": "Zurich",
    "praha": "Prague", "warszawa": "Warsaw", "kraków": "Krakow",
    "kiev": "Kyiv", "são paulo": "Sao Paulo", "bogotá": "Bogota",
    "bengaluru": "Bangalore", "gurugram": "Gurgaon",
    "ciudad de méxico": "Mexico City", "ciudad de mexico": "Mexico City",
    "cdmx": "Mexico City",
    # A city's own-language name, to the English name the board already
    # lists, so one city is one filter option.
    "wien": "Vienna", "milano": "Milan", "lisboa": "Lisbon", "den haag": "The Hague",
    "antwerpen": "Antwerp", "bruxelles": "Brussels", "brussel": "Brussels",
    "ho chi minh": "Ho Chi Minh City", "bucuresti": "Bucharest", "bucurești": "Bucharest",
    "torino": "Turin", "roma": "Rome", "nürnberg": "Nuremberg", "genève": "Geneva",
    "napoli": "Naples", "firenze": "Florence",
    # Hebrew to the same English name the rest of the board uses, so one
    # city is one entry however the board that posted it writes.
    "תל אביב": "Tel Aviv", "ירושלים": "Jerusalem",
    "חיפה": "Haifa", "הרצליה": "Herzliya",
    "רעננה": "Raanana", "פתח תקווה": "Petah Tikva",
    "נתניה": "Netanya", "רחובות": "Rehovot",
    "רמת גן": "Ramat Gan", "באר שבע": "Beer Sheva",
    "אשדוד": "Ashdod", "חולון": "Holon",
    "כפר סבא": "Kfar Saba",
    "אזור המרכז": "Central District",
    "אזור השפלה": "Shfela",
    "אזור השרון": "Sharon",
    "אזור הצפון": "Northern District",
    "אזור הדרום": "Southern District",
    "ירושלים והסביבה": "Jerusalem",
    # Yokneam is the town people mean, Yokneam Illit with the tech park;
    # the old moshava next to it is a separate village.
    "yokneam illit": "Yokneam", "yoqneam": "Yokneam", "יקנעם": "Yokneam", "יקנעם עילית": "Yokneam",
}

# A work arrangement, not a place. These sit where a city would and would
# otherwise become the most popular "city" on the board.
_NOT_A_CITY = {
    "remote", "hybrid", "onsite", "on-site", "office", "global", "worldwide",
    "distributed", "anywhere", "flexible", "various", "multiple locations",
    "location", "all", "emea", "apac", "amer", "latam", "europe", "asia",
    "north america", "south america", "latin america", "middle east", "africa",
    "telecommuter", "telecommute",
}

CITY_ALIASES_FOLDED = _fold_keys(CITY_ALIASES)
_NOT_A_CITY_FOLDED = {_norm(x) for x in _NOT_A_CITY}

MAX_CITIES = 4


def _canonical_city(seg: str) -> str | None:
    low = _norm(seg.strip().strip("."))
    if not low or low in _NOT_A_CITY_FOLDED:
        return None
    if low in CITY_ALIASES_FOLDED:
        return CITY_ALIASES_FOLDED[low]
    if low in CITIES_FOLDED:
        return low.title()
    # A qualifier tacked onto a known city: "Herzliya Pituach Office",
    # "Chicago, IL (Southwest)". Longest first so "new york city" is not
    # shadowed by "new york".
    for city in sorted(CITIES_FOLDED, key=len, reverse=True):
        if low.startswith(city + " ") or low.endswith(" " + city):
            return CITY_ALIASES_FOLDED.get(city, city.title())
    # A postal code or a street address: "Erie PA, 16502, 232 West 25th St"
    # used to list 16502 and 232 West 25th St as cities. A number followed
    # by a space starts an address; "6th of October" keeps its city.
    # Coordinates and PO boxes too ("39.971850885", "P.O. Box 780").
    if low.replace(" ", "").isdigit() or re.match(r"\d+ ", low) or re.fullmatch(r"-?\d+\.\d+", low) \
            or re.match(r"p\.? ?o\.? box\b", low):
        return None
    # Not a place we know, but not obviously not one either. Anything
    # that is really a country, a state or a code has already been
    # excluded by the caller.
    if len(low) > 2 and not _ALPHA3_RE.match(seg.strip()) and not _UPPER2_RE.match(seg.strip()):
        return seg.strip()
    return None


def _tokens(group: str):
    """What each segment of one location group is, in the order written.

    Yields ("city", name), ("country", code), ("state", US state code) or
    ("region", country code or None). cities_of keeps the cities;
    places_of also uses the rest to say which country and state each city
    sits in.
    """
    segments = [s.strip() for s in _SPLIT.split(group) if s.strip()]
    group_codes = None
    taken = False
    for i, seg in enumerate(segments):
        low = _norm(seg)
        # A segment that resolves to a country is a country, not a city,
        # however much "Georgia" might want to be both. A spelled-out US
        # state resolves to US and is kept as the state it is.
        code = _segment_country(seg)
        if code and low not in CITIES_FOLDED:
            state = US_STATE_CODES_FOLDED.get(_norm(seg.strip().strip("."))) if code == "US" else None
            yield ("state", state) if state else ("country", code)
            continue
        region = _admin1_country(seg, segments[1] if i == 0 and len(segments) > 1 else "")
        if region:
            yield ("region", region)
            continue
        if low in ADMIN1_IN_COUNTRY_FOLDED or (taken and low in _US_STATE_CITIES):
            if group_codes is None:
                group_codes = set(countries_of(group))
            if low in ADMIN1_IN_COUNTRY_FOLDED and group_codes & set(ADMIN1_IN_COUNTRY_FOLDED[low]):
                yield ("region", None)
                continue
            if low in _US_STATE_CITIES and taken and "US" in group_codes:
                yield ("state", US_STATE_CODES_FOLDED[low])
                continue
        state = _us_state_code(seg)
        if state:
            yield ("state", state)
            continue
        if seg in PROVINCE_CODES:
            yield ("region", PROVINCE_CODES[seg])
            continue
        m = _STATE_ZIP_RE.match(seg)
        if m and m.group(1) in US_STATES:
            yield ("state", m.group(1))
            continue
        m = _STATE_SUFFIX_RE.match(seg)
        if m and m.group(2) in US_STATES:
            # "Remote-NY" is the state with no city.
            city = _canonical_city(m.group(1))
            if city:
                taken = True
                yield ("city", city)
            yield ("state", m.group(2))
            continue
        city = _canonical_city(seg)
        if city:
            taken = True
            yield ("city", city)


def _groups(location: str) -> list[str]:
    return [g for g in location.split(";") if g.strip()] or [location]


def cities_of(location: str | None) -> list[str]:
    """Every city a location names, canonicalised and deduplicated."""
    if not location:
        return []
    out: list[str] = []
    for group in _groups(location):
        for kind, value in _tokens(group):
            # Same reasoning as countries_of: these boards separate offices
            # with commas, so taking only the first left a ten-city posting
            # filed under one city.
            if kind == "city" and value not in out:
                out.append(value)
    return out[:MAX_CITIES]


def places_of(location: str | None) -> list[tuple[str | None, str | None, str]]:
    """(country, US state, city) for each city a location names.

    The board's columns keep countries and cities apart, so a job in "Tel
    Aviv, Israel; New York, NY" is filed under both cities in both
    countries. This keeps each city with the country and state written
    beside it, for anything that needs one place per city, such as a map.
    A city's country is the next country after it in the same group, else
    the group's only country, else the job's only country, else None. The
    state is the next US state written after it, before the next city, and
    only for a US city. Nothing is guessed: a city with no state stays
    without one. Same cap and order as cities_of.
    """
    if not location:
        return []
    job_codes = countries_of(location)
    out: list[tuple] = []
    for group in _groups(location):
        entries: list[list] = []
        for kind, value in _tokens(group):
            if kind == "city":
                entries.append([None, None, value])
            elif kind == "state" and entries and entries[-1][1] is None:
                entries[-1][1] = value
            elif kind in ("country", "region") and value:
                for e in entries:
                    e[0] = e[0] or value
        group_codes = countries_of(group)
        fallback = (group_codes[0] if len(group_codes) == 1
                    else job_codes[0] if len(job_codes) == 1 else None)
        for country, state, city in entries:
            # "Tel Aviv, IL" carries a state code too; the group says Israel.
            country = country or fallback or ("US" if state else None)
            place = (country, state if country == "US" else None, city)
            if place not in out:
                out.append(place)
    cities = cities_of(location)
    # "Torrington - Torrington, CT" names one place twice; keep the one with its state.
    stated = {(c, city) for c, s, city in out if s}
    return [p for p in out if p[2] in cities and (p[1] or (p[0], p[2]) not in stated)]


def city_string(location: str | None) -> str:
    return ",".join(cities_of(location))
