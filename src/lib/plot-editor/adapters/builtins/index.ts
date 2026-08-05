import { GeometryAdapterRegistry } from '../GeometryAdapterRegistry';
import { ArrowGeometryAdapter } from './ArrowAdapter';
import { CircleGeometryAdapter } from './CircleAdapter';
import { LineGeometryAdapter } from './LineAdapter';
import { PointGeometryAdapter } from './PointAdapter';
import { PolygonGeometryAdapter } from './PolygonAdapter';
import { RectangleGeometryAdapter } from './RectangleAdapter';
import { SectorGeometryAdapter } from './SectorAdapter';
import { TextGeometryAdapter } from './TextAdapter';

/** 创建包含设计文档八类 GIS Graphics 的完整内置注册表。 */
export function createBuiltinGeometryAdapterRegistry(): GeometryAdapterRegistry {
	const registry = new GeometryAdapterRegistry();
	registry.register( new PointGeometryAdapter() );
	registry.register( new LineGeometryAdapter() );
	registry.register( new PolygonGeometryAdapter() );
	registry.register( new RectangleGeometryAdapter() );
	registry.register( new SectorGeometryAdapter() );
	registry.register( new ArrowGeometryAdapter() );
	registry.register( new TextGeometryAdapter() );
	registry.register( new CircleGeometryAdapter() );
	return registry;
}

export { ArrowGeometryAdapter } from './ArrowAdapter';
export { CircleGeometryAdapter } from './CircleAdapter';
export { LineGeometryAdapter } from './LineAdapter';
export { PointGeometryAdapter } from './PointAdapter';
export { PolygonGeometryAdapter } from './PolygonAdapter';
export { RectangleGeometryAdapter } from './RectangleAdapter';
export { SectorGeometryAdapter } from './SectorAdapter';
export { TextGeometryAdapter } from './TextAdapter';
