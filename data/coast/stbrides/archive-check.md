# St Brides Bay — NRW historic LIDAR archive check

Run 2026-10-25 04:10 UTC. Check only — nothing on the map was changed.

The coast map has about **4.22 km²** of hatched "not surveyed" foreshore (sampled every 4 m).


The catalogue lists **124** historic tiles over the bay, in 19 downloads; 19 were downloaded and read (429 MB).


**Result: older surveys have heights for 42% of the 'not surveyed' foreshore** (about 1.79 km² of 4.22 km²).


How low the filled heights go (m above Ordnance Datum; Milford Haven chart datum is −3.71 m OD, so −3 m OD is about 0.7 m above chart datum):

- below -3 m: 0%
- -3 to -2 m: 0%
- -2 to -1 m: 0%
- -1 to 0 m: 0%
- above 0 m: 1%


## Tiles

| Download | Date flown | Resolution (m) | Result | Cells with height | New | Lowest (m OD) |
|---|---|---|---|---|---|---|
| 1m_res_SM72_2013_dtm.zip | 2-Apr-2013 | 1 | ok (13 grids) | 0 | 0 | None |
| 1m_res_SM80_2012_dtm.zip | 18-Dec-2012 | 1 | ok (4 grids) | 0 | 0 | None |
| 1m_res_SM82_2009_dtm.zip | 18---23-Apr-2009 | 1 | ok (2 grids) | 0 | 0 | None |
| 1m_res_SM82_2013_dtm.zip | 2-Apr-2013 | 1 | ok (13 grids) | 0 | 0 | None |
| 2m_res_SM70_2004_dtm.zip | March-2004 | 2 | ok (4 grids) | 102 | 102 | -42.59 |
| 2m_res_SM70_2006_dtm.zip | April---May-2006 | 2 | ok (8 grids) | 201 | 132 | -50.0 |
| 2m_res_SM71_2006_dtm.zip | April---May-2006 | 2 | ok (1 grids) | 3 | 3 | -27.5 |
| 2m_res_SM72_2006_dtm.zip | April---May-2006 | 2 | ok (19 grids) | 0 | 0 | None |
| 2m_res_SM80_2004_dtm.zip | March-2004 | 2 | ok (22 grids) | 19 | 19 | -34.81 |
| 2m_res_SM80_2006_dtm.zip | April---May-2006 | 2 | ok (5 grids) | 8 | 5 | -9.92 |
| 2m_res_SM81_2004_dtm.zip | March-2004 | 2 | ok (6 grids) | 0 | 0 | None |
| 2m_res_SM81_2006_dtm.zip | April---May-2006 | 2 | ok (14 grids) | 1904 | 1904 | -50.0 |
| 2m_res_SM82_2004_dtm.zip | March-2004 | 2 | ok (7 grids) | 0 | 0 | None |
| 2m_res_SM82_2006_dtm.zip | April---May-2006 | 2 | ok (18 grids) | 0 | 0 | None |
| 2m_res_SM82_2007_dtm.zip | 26-Mar-2007 | 2 | ok (9 grids) | 0 | 0 | None |
| 50cm_res_SM70_2011_dtm.zip | 28-Feb-2011 | 0.5 | ok (32 grids) | 100828 | 100819 | -50.0 |
| 50cm_res_SM71_2011_dtm.zip | 28-Feb-2011 | 0.5 | ok (4 grids) | 8605 | 8605 | -50.0 |
| 50cm_res_SM81_2014_dtm.zip | 30-Mar-2014 | 0.5 | ok (2 grids) | 0 | 0 | None |
| 50cm_res_SM82_2014_dtm.zip | 30-Mar-2014 | 0.5 | ok (19 grids) | 0 | 0 | None |

Took 2.1 minutes.


Contains Natural Resources Wales information © Natural Resources Wales and Database Right (Open Government Licence).


## Log

```
Area (British National Grid): 170900,202608 to 187163,223776
'Not surveyed' cells sampled: 263500 (about 4.22 km²)
Catalogue answered at https://datamap.gov.wales/geoserver/ows (WFS 2.0.0): 124 tiles
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

