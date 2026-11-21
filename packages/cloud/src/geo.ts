// Workers have no filesystem: bundle the geo data the engine needs (land mask for ocean routing,
// gazetteer for place names) and hand it to the data package.
import { setGeoSource } from '@coldlaunch/data';
import landmask from '../../data/geo/landmask.json';
import places from '../../data/geo/places.json';

setGeoSource({ 'landmask.json': landmask, 'places.json': places });
