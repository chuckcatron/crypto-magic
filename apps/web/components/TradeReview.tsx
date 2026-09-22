import type { TradeAnalysis } from '@/lib/api';

/**
 * The expanded post-mortem under a trade row.
 *
 * Written by a local model after the trade closed. It had no part in the
 * decision and cannot influence a future one — the note at the bottom says so
 * explicitly, so nobody reading this later mistakes it for a signal source.
 */
export function TradeReview({ analysis }: { analysis: TradeAnalysis | null }) {
  if (!analysis) {
    return <p className="review-pending">No review yet — the local model writes these in the background.</p>;
  }

  return (
    <div className="review">
      <p className="review-summary">{analysis.summary}</p>

      <div className="review-cols">
        {analysis.whatWorked.length > 0 && (
          <div>
            <div className="review-h">What worked</div>
            <ul>
              {analysis.whatWorked.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        )}
        {analysis.whatDidnt.length > 0 && (
          <div>
            <div className="review-h">What didn&apos;t</div>
            <ul>
              {analysis.whatDidnt.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {analysis.lesson && <div className="review-lesson">{analysis.lesson}</div>}

      <div className="review-meta">
        {analysis.model} · {(analysis.durationMs / 1000).toFixed(1)}s
        {analysis.newsCount > 0
          ? ` · ${analysis.newsCount} headline${analysis.newsCount === 1 ? '' : 's'} in scope${analysis.usedNews ? ', referenced' : ', not relevant'}`
          : ' · no headlines'}
        {' · written after the trade closed; it did not influence any decision'}
      </div>
    </div>
  );
}
