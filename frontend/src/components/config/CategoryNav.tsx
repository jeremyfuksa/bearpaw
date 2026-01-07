import { useState, useRef, useEffect } from 'react';

export interface CategoryDefinition {
  id: string;
  label: string;
}

interface CategoryNavProps {
  categories: CategoryDefinition[];
  advancedCategories: CategoryDefinition[];
  activeCategory: string;
  onCategoryChange: (categoryId: string) => void;
  isMobile?: boolean;
}

export function CategoryNav({
  categories,
  advancedCategories,
  activeCategory,
  onCategoryChange,
  isMobile = false,
}: CategoryNavProps) {
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const advancedContentRef = useRef<HTMLDivElement>(null);

  // Auto-expand advanced section if an advanced category is active
  useEffect(() => {
    const isAdvancedActive = advancedCategories.some(cat => cat.id === activeCategory);
    if (isAdvancedActive) {
      setAdvancedExpanded(true);
    }
  }, [activeCategory, advancedCategories]);

  const renderNavItem = (category: CategoryDefinition) => (
    <button
      key={category.id}
      className={`category-nav-item ${activeCategory === category.id ? 'category-nav-item--active' : ''}`}
      aria-current={activeCategory === category.id ? 'page' : undefined}
      onClick={() => onCategoryChange(category.id)}
    >
      {category.label}
    </button>
  );

  if (isMobile) {
    // Mobile: horizontal scrollable layout
    return (
      <div className="config-sidebar">
        <div className="config-sidebar-inner">
          {categories.map(renderNavItem)}
          {advancedCategories.map(renderNavItem)}
        </div>
      </div>
    );
  }

  // Desktop: vertical sidebar with collapsible advanced section
  return (
    <nav className="config-sidebar" aria-label="Configuration categories">
      <div>
        {categories.map(renderNavItem)}

        <div className="category-nav-section">
          <button
            className="category-nav-section-header"
            onClick={() => setAdvancedExpanded(!advancedExpanded)}
            aria-expanded={advancedExpanded}
            aria-controls="advanced-categories"
          >
            <span>Advanced</span>
            <svg
              className={`category-nav-section-chevron ${advancedExpanded ? 'category-nav-section-chevron--expanded' : ''}`}
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="2,4 6,8 10,4" />
            </svg>
          </button>
          <div
            id="advanced-categories"
            className="category-nav-section-items"
            style={{
              height: advancedExpanded ? advancedContentRef.current?.scrollHeight : 0,
            }}
            aria-hidden={!advancedExpanded}
          >
            <div ref={advancedContentRef}>
              {advancedCategories.map(renderNavItem)}
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}
