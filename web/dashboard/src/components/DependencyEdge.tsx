// =============================================================================
// Dependency Edge Component
// =============================================================================

import { memo } from 'react';
import { EdgeProps, getBezierPath, EdgeLabelRenderer } from 'reactflow';
import type { DependencyEdgeData } from '../types';
import { dependencyColors } from '../utils/statusColors';

import './DependencyEdge.css';

function DependencyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
}: EdgeProps<DependencyEdgeData>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  
  const edgeColor = data?.type ? dependencyColors[data.type] : '#6b7280';
  
  // Adjust color based on target status
  let strokeColor = style?.stroke || edgeColor;
  if (data?.targetStatus === false && data?.required) {
    strokeColor = '#ef4444'; // red for required down
  } else if (data?.targetStatus === false) {
    strokeColor = '#f59e0b'; // orange for optional down
  }
  
  const isAnimated = data?.type === 'ws';
  
  return (
    <>
      <path
        id={id}
        className={`dependency-edge ${isAnimated ? 'animated' : ''}`}
        d={edgePath}
        style={{
          ...style,
          stroke: strokeColor,
        }}
        markerEnd={markerEnd}
      />
      
      {data?.type && (
        <EdgeLabelRenderer>
          <div
            className="dependency-edge-label"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              backgroundColor: '#1e293b',
              color: strokeColor,
              pointerEvents: 'all',
            }}
          >
            {data.type.toUpperCase()}
            {data.required && <span className="required-badge">!</span>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export default memo(DependencyEdge);
