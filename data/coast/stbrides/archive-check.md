# St Brides Bay — NRW historic LIDAR archive check

Run 2026-10-25 04:16 UTC. Check only — nothing on the map was changed.

The coast map has about **4.22 km²** of hatched "not surveyed" foreshore (sampled every 4 m).


The catalogue lists **124** historic tiles over the bay, in 19 downloads; 19 were downloaded and read (429 MB).


**Result: older surveys have heights for 42% of the 'not surveyed' foreshore** (about 1.79 km² of 4.22 km²).


How low the filled heights go (m above Ordnance Datum; Milford Haven chart datum is −3.71 m OD, so −3 m OD is about 0.7 m above chart datum):

- below -6 m (suspicious: deeper than any foreshore): 0%
- -6 to -3 m: 0%
- -3 to -2 m: 0%
- -2 to -1 m: 0%
- -1 to 0 m: 0%
- 0 to 5 m: 0%
- above 5 m (suspicious for foreshore): 100%


## Tiles

| Download | Date flown | Res. (m) | Result | Gap cells with height | New | Heights 5% / median / 95% (m OD) | Exactly -50/0 etc. | Agreement with 2020-23: points, median diff (m), % within 0.5 m |
|---|---|---|---|---|---|---|---|---|
| 1m_res_SM72_2013_dtm.zip | 2-Apr-2013 | 1 | ok (13 grids) | 0 | 0 |  |  |  |
| 1m_res_SM80_2012_dtm.zip | 18-Dec-2012 | 1 | ok (4 grids) | 0 | 0 |  |  |  |
| 1m_res_SM82_2009_dtm.zip | 18---23-Apr-2009 | 1 | ok (2 grids) | 0 | 0 |  |  |  |
| 1m_res_SM82_2013_dtm.zip | 2-Apr-2013 | 1 | ok (13 grids) | 0 | 0 |  |  |  |
| 2m_res_SM70_2004_dtm.zip | March-2004 | 2 | ok (4 grids) | 102 | 102 | -18.4 / 177.53 / 483.37 | 0 | 92, +734.11, 0% |
| 2m_res_SM70_2006_dtm.zip | April---May-2006 | 2 | ok (8 grids) | 201 | 132 | -42.5 / 75.0 / 235.0 | 6 | 840, +598.83, 0% |
| 2m_res_SM71_2006_dtm.zip | April---May-2006 | 2 | ok (1 grids) | 3 | 3 | -12.0 / 127.5 / 216.35 | 0 | 70, +649.27, 0% |
| 2m_res_SM72_2006_dtm.zip | April---May-2006 | 2 | ok (19 grids) | 0 | 0 |  |  |  |
| 2m_res_SM80_2004_dtm.zip | March-2004 | 2 | ok (22 grids) | 19 | 19 | -8.6 / 234.21 / 763.3 | 0 | 570, +699.95, 0% |
| 2m_res_SM80_2006_dtm.zip | April---May-2006 | 2 | ok (5 grids) | 8 | 5 | 6.02 / 132.31 / 365.74 | 0 | 91, +764.4, 1% |
| 2m_res_SM81_2004_dtm.zip | March-2004 | 2 | ok (6 grids) | 0 | 0 |  |  |  |
| 2m_res_SM81_2006_dtm.zip | April---May-2006 | 2 | ok (14 grids) | 1904 | 1904 | -30.0 / 223.75 / 1267.12 | 8 | 607, +629.5, 0% |
| 2m_res_SM82_2004_dtm.zip | March-2004 | 2 | ok (7 grids) | 0 | 0 |  |  |  |
| 2m_res_SM82_2006_dtm.zip | April---May-2006 | 2 | ok (18 grids) | 0 | 0 |  |  | 8, +437.81, 0% |
| 2m_res_SM82_2007_dtm.zip | 26-Mar-2007 | 2 | ok (9 grids) | 0 | 0 |  |  |  |
| 50cm_res_SM70_2011_dtm.zip | 28-Feb-2011 | 0.5 | ok (32 grids) | 100828 | 100819 | 500.0 / 950.0 / 1290.0 | 28 | 1577, +1079.8, 0% |
| 50cm_res_SM71_2011_dtm.zip | 28-Feb-2011 | 0.5 | ok (4 grids) | 8605 | 8605 | 550.0 / 950.0 / 1300.0 | 2 | 61, +974.8, 0% |
| 50cm_res_SM81_2014_dtm.zip | 30-Mar-2014 | 0.5 | ok (2 grids) | 0 | 0 |  |  | 30, +269.75, 0% |
| 50cm_res_SM82_2014_dtm.zip | 30-Mar-2014 | 0.5 | ok (19 grids) | 0 | 0 |  |  | 5, +389.7, 0% |

Took 1.7 minutes.


Contains Natural Resources Wales information © Natural Resources Wales and Database Right (Open Government Licence).


## Log

```
Area (British National Grid): 170900,202608 to 187163,223776
'Not surveyed' cells sampled: 263500 (about 4.22 km²)
Catalogue answered at https://datamap.gov.wales/geoserver/ows (WFS 2.0.0): 124 tiles
Reference points (2020-23 beach and foreshore): 10798
19 separate downloads (0 catalogue tiles have no terrain model)
1m_res_SM72_2013_dtm.zip: 23 MB downloaded
1m_res_SM72_2013_dtm.zip 2-Apr-2013 (1 m): 0 cells with height, 0 new, 23.2 MB
1m_res_SM80_2012_dtm.zip: 11 MB downloaded
1m_res_SM80_2012_dtm.zip 18-Dec-2012 (1 m): 0 cells with height, 0 new, 10.9 MB
1m_res_SM82_2009_dtm.zip: 5 MB downloaded
1m_res_SM82_2009_dtm.zip 18---23-Apr-2009 (1 m): 0 cells with height, 0 new, 4.8 MB
1m_res_SM82_2013_dtm.zip: 55 MB downloaded
1m_res_SM82_2013_dtm.zip 2-Apr-2013 (1 m): 0 cells with height, 0 new, 55.0 MB
2m_res_SM70_2004_dtm.zip: 3 MB downloaded
2m_res_SM70_2004_dtm.zip March-2004 (2 m): 102 cells with height, 102 new, 3.1 MB
2m_res_SM70_2006_dtm.zip: 12 MB downloaded
2m_res_SM70_2006_dtm.zip April---May-2006 (2 m): 201 cells with height, 132 new, 12.4 MB
2m_res_SM71_2006_dtm.zip: 2 MB downloaded
2m_res_SM71_2006_dtm.zip April---May-2006 (2 m): 3 cells with height, 3 new, 1.5 MB
2m_res_SM72_2006_dtm.zip: 26 MB downloaded
2m_res_SM72_2006_dtm.zip April---May-2006 (2 m): 0 cells with height, 0 new, 26.3 MB
2m_res_SM80_2004_dtm.zip: 63 MB downloaded
2m_res_SM80_2004_dtm.zip March-2004 (2 m): 19 cells with height, 19 new, 63.2 MB
2m_res_SM80_2006_dtm.zip: 5 MB downloaded
2m_res_SM80_2006_dtm.zip April---May-2006 (2 m): 8 cells with height, 5 new, 4.7 MB
2m_res_SM81_2004_dtm.zip: 5 MB downloaded
2m_res_SM81_2004_dtm.zip March-2004 (2 m): 0 cells with height, 0 new, 5.2 MB
2m_res_SM81_2006_dtm.zip: 19 MB downloaded
2m_res_SM81_2006_dtm.zip April---May-2006 (2 m): 1904 cells with height, 1904 new, 18.5 MB
2m_res_SM82_2004_dtm.zip: 7 MB downloaded
2m_res_SM82_2004_dtm.zip March-2004 (2 m): 0 cells with height, 0 new, 7.3 MB
2m_res_SM82_2006_dtm.zip: 34 MB downloaded
2m_res_SM82_2006_dtm.zip April---May-2006 (2 m): 0 cells with height, 0 new, 33.9 MB
2m_res_SM82_2007_dtm.zip: 11 MB downloaded
2m_res_SM82_2007_dtm.zip 26-Mar-2007 (2 m): 0 cells with height, 0 new, 11.0 MB
50cm_res_SM70_2011_dtm.zip: 100 MB downloaded
50cm_res_SM70_2011_dtm.zip 28-Feb-2011 (0.5 m): 100828 cells with height, 100819 new, 100.1 MB
50cm_res_SM71_2011_dtm.zip: 8 MB downloaded
50cm_res_SM71_2011_dtm.zip 28-Feb-2011 (0.5 m): 8605 cells with height, 8605 new, 7.6 MB
50cm_res_SM81_2014_dtm.zip: 4 MB downloaded
50cm_res_SM81_2014_dtm.zip 30-Mar-2014 (0.5 m): 0 cells with height, 0 new, 3.9 MB
50cm_res_SM82_2014_dtm.zip: 37 MB downloaded
50cm_res_SM82_2014_dtm.zip 30-Mar-2014 (0.5 m): 0 cells with height, 0 new, 36.8 MB
```

